import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createECDH } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { openDatabase, type Database } from "../server/db";
import { createApp } from "../server/app";
import {
  inspectPushSettings,
  safePushLink,
  type PushSettings,
  type PushGateway,
  type PushMessage,
} from "../server/push";
import { uid, notify } from "../server/domain";
import { tick } from "../server/worker";
import type { FastifyInstance } from "fastify";

const ec = createECDH("prime256v1");
ec.generateKeys();
const vapid = ec.getPublicKey().toString("base64url");
const web = {
  apiKey: "public-test-api-key",
  appId: "1:123456:web:test-app",
  projectId: "rcs-test-project",
  messagingSenderId: "123456",
};
const configured: PushSettings = {
  ready: true,
  status: "ready",
  issues: [],
  config: web,
  vapidKey: vapid,
  origin: "https://rcs.example.com",
};
let state: PushSettings = configured,
  sent: PushMessage[] = [],
  sendError: any = null,
  db: Database,
  app: FastifyInstance,
  passwordHash: string;
const gateway: PushGateway = {
  settings: async () => state,
  send: async (message) => {
    if (sendError) throw sendError;
    sent.push(message);
    return "projects/rcs/messages/test";
  },
};
let users: string[],
  sessions: { cookie: string; csrf: string }[],
  attempt = 0;
async function request(
  i: number,
  method: any,
  url: string,
  body?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url: "/api" + url,
    headers: { cookie: sessions[i].cookie, "x-csrf-token": sessions[i].csrf },
    ...(body === undefined ? {} : { payload: body }),
  });
}
async function device(i = 1, token = "test-device-token-" + uid()) {
  const r = await request(i, "POST", "/me/push-devices", { token });
  expect(r.statusCode, r.body).toBe(200);
  return { id: r.json().id, token };
}
beforeAll(async () => {
  db = await openDatabase(":memory:");
  passwordHash = await hash("PushTests!2026");
  app = await createApp(db, { push: gateway });
  await app.ready();
});
beforeEach(async () => {
  state = configured;
  sent = [];
  sendError = null;
  users = [uid(), uid()];
  await db.query("TRUNCATE users,shift_types CASCADE");
  for (let i = 0; i < 2; i++)
    await db.query(
      "INSERT INTO users(id,name,phone,password_hash,role) VALUES($1,$2,$3,$4,$5)",
      [
        users[i],
        ["Админ", "Бариста"][i],
        `+37529111111${i}`,
        passwordHash,
        i === 0 ? "admin" : "barista",
      ],
    );
  sessions = [];
  for (let i = 0; i < 2; i++) {
    const r = await app.inject({
      remoteAddress: "127.1.0." + ++attempt,
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: `+37529111111${i}`, password: "PushTests!2026" },
    });
    expect(r.statusCode).toBe(200);
    sessions.push({
      cookie: r.headers["set-cookie"]!.toString().split(";")[0],
      csrf: r.json().csrf,
    });
  }
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe("Firebase configuration", () => {
  it("reports missing configuration without enabling a nonfunctional button", async () => {
    const result = await inspectPushSettings({});
    expect(result.ready).toBe(false);
    expect(result.status).toBe("unconfigured");
    expect(result.issues).toHaveLength(4);
    state = result;
    expect((await request(1, "GET", "/auth/me")).json().push_config).toBeNull();
    expect(
      (await request(1, "POST", "/me/push-devices", { token: "a".repeat(30) }))
        .statusCode,
    ).toBe(409);
  });
  it("validates public config, VAPID and HTTPS; does not expose arbitrary secret fields", async () => {
    const env = {
      FIREBASE_WEB_CONFIG: JSON.stringify({
        ...web,
        private_key: "must-not-leak",
      }),
      FIREBASE_VAPID_KEY: vapid,
      FIREBASE_USE_ADC: "1",
      APP_ORIGIN: "https://rcs.example.com",
    };
    const result = await inspectPushSettings(env);
    expect(result.ready).toBe(true);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(
      (await inspectPushSettings({ ...env, FIREBASE_VAPID_KEY: "invalid" }))
        .ready,
    ).toBe(false);
    expect(
      (
        await inspectPushSettings({
          ...env,
          APP_ORIGIN: "http://192.168.1.4:5173",
        })
      ).ready,
    ).toBe(false);
    expect(
      (
        await inspectPushSettings({
          ...env,
          APP_ORIGIN: "http://localhost:5173",
        })
      ).ready,
    ).toBe(true);
    expect(
      (await inspectPushSettings({ ...env, FIREBASE_WEB_CONFIG: "broken" }))
        .ready,
    ).toBe(false);
  });
  it("hides inaccessible credential paths and rejects external deep links", async () => {
    const result = await inspectPushSettings({
      FIREBASE_WEB_CONFIG: JSON.stringify(web),
      FIREBASE_VAPID_KEY: vapid,
      APP_ORIGIN: "https://rcs.example.com",
      GOOGLE_APPLICATION_CREDENTIALS: "C:/private/missing-secret.json",
    });
    expect(result.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain("missing-secret");
    expect(safePushLink("https://evil.example")).toBe("notifications");
    expect(safePushLink("shift:" + uid())).toMatch(/^shift:/);
  });
});
describe("Device setup and actual transport invocation", () => {
  it("preserves the Android platform through device registration and test sending", async () => {
    const r = await request(1, "POST", "/me/push-devices", {
      token: "android-token-" + uid(),
      platform: "android",
    });
    expect(r.statusCode).toBe(200);
    const d = r.json();
    const test = await request(1, "POST", "/me/push-test", { device_id: d.id });
    expect(test.statusCode).toBe(200);
    expect(sent[0].platform).toBe("android");
  });
  it("exposes setup diagnostics only to admin and private device state only to its owner", async () => {
    const d = await device();
    expect((await request(1, "GET", "/admin/push-status")).statusCode).toBe(
      403,
    );
    const adminStatus = (await request(0, "GET", "/admin/push-status")).json();
    expect(adminStatus.project_id).toBe(web.projectId);
    expect(adminStatus).not.toHaveProperty("credentials");
    expect(
      (await request(1, "GET", "/me/push-status?device_id=" + d.id)).json()
        .registered,
    ).toBe(true);
    expect(
      (await request(0, "GET", "/me/push-status?device_id=" + d.id)).json()
        .registered,
    ).toBe(false);
  });
  it("sends a test only to the authenticated user chosen device and records acceptance", async () => {
    const own = await device(),
      foreign = await device(0);
    expect(
      (await request(1, "POST", "/me/push-test", { device_id: foreign.id }))
        .statusCode,
    ).toBe(404);
    const result = await request(1, "POST", "/me/push-test", {
      device_id: own.id,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ accepted: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe(own.token);
    expect(
      (await db.query("SELECT attempts,sent_at FROM deliveries"))[0].sent_at,
    ).toBeTruthy();
  });
  it("removes expired tokens and does not return provider secrets in errors", async () => {
    const d = await device();
    sendError = {
      code: "messaging/registration-token-not-registered",
      message: "private provider details",
    };
    const result = await request(1, "POST", "/me/push-test", {
      device_id: d.id,
    });
    expect(result.statusCode).toBe(410);
    expect(result.body).not.toContain("private provider");
    expect(
      await db.query("SELECT id FROM push_devices WHERE id=$1", [d.id]),
    ).toEqual([]);
  });
  it("reports provider rejection instead of falsely reporting delivery", async () => {
    const d = await device();
    sendError = {
      code: "messaging/authentication-error",
      message: "secret-credential-text",
    };
    const result = await request(1, "POST", "/me/push-test", {
      device_id: d.id,
    });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("secret-credential-text");
    expect(
      (await db.query("SELECT count(*)::integer AS n FROM deliveries"))[0].n,
    ).toBe(0);
  });
});
describe("Push queue", () => {
  it("sends saved notifications through the transport and records success once", async () => {
    const d = await device();
    await db.tx((sql) =>
      notify(
        sql,
        [users[1]],
        "Новая смена",
        "Проверьте график",
        "schedule",
        "schedule",
      ),
    );
    await tick(db, gateway);
    await tick(db, gateway);
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe(d.token);
    expect(sent[0].link).toBe("schedule");
  });
  it("retries a temporary failure with backoff instead of losing the notification", async () => {
    await device();
    await db.tx((sql) =>
      notify(sql, [users[1]], "Новая смена", "Проверьте график"),
    );
    sendError = { code: "messaging/server-unavailable" };
    await tick(db, gateway);
    let row = (await db.query("SELECT * FROM deliveries"))[0];
    expect(row.attempts).toBe(1);
    expect(row.sent_at).toBeNull();
    sendError = null;
    await db.query(
      "UPDATE deliveries SET next_attempt=clock_timestamp()-interval '1 second'",
    );
    await tick(db, gateway);
    row = (await db.query("SELECT * FROM deliveries"))[0];
    expect(row.attempts).toBe(2);
    expect(row.sent_at).toBeTruthy();
  });
  it("respects newly disabled notification categories and cross-user token reassignment", async () => {
    const d = await device();
    await db.tx((sql) =>
      notify(
        sql,
        [users[1]],
        "Личное событие",
        "Не доставлять другому аккаунту",
      ),
    );
    await device(0, d.token);
    await tick(db, gateway);
    expect(sent).toEqual([]);
    await db.tx((sql) =>
      notify(sql, [users[0]], "Новое событие", "Для нового пользователя"),
    );
    await db.query(
      "INSERT INTO preferences(user_id,schedule) VALUES($1,false)",
      [users[0]],
    );
    await tick(db, gateway);
    expect(sent).toEqual([]);
  });
});
