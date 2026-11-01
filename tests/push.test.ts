import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createECDH, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        .webReady,
    ).toBe(false);
    expect(
      (
        await inspectPushSettings({
          ...env,
          APP_ORIGIN: "http://192.168.1.4:5173",
        })
      ).webReady,
    ).toBe(false);
    expect(
      (
        await inspectPushSettings({
          ...env,
          APP_ORIGIN: "http://localhost:5173",
        })
      ).webReady,
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
  it("enables native Android with a service account, without Web config, VAPID or HTTPS hosting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rcs-firebase-")), file = join(directory, "service-account.json");
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
    try {
      await writeFile(file, JSON.stringify({ type: "service_account", project_id: web.projectId, client_email: `rcs-push@${web.projectId}.iam.gserviceaccount.com`, private_key: key.toString() }), { mode: 0o600 });
      state = await inspectPushSettings({ GOOGLE_APPLICATION_CREDENTIALS: file, APP_ORIGIN: "http://192.168.1.7:3001" });
      expect(state).toMatchObject({ ready: true, androidReady: true, webReady: false, projectId: web.projectId, config: null });
      const me = (await request(1, "GET", "/auth/me")).json();
      expect(me).toMatchObject({ push_ready: false, push_android_ready: true, push_project_id: web.projectId, push_config: null });
      expect(JSON.stringify(me)).not.toContain("private_key");
      const registered = await request(1, "POST", "/me/push-devices", { platform: "android", token: "native-only-token-" + uid(), user_id: users[1] });
      expect(registered.statusCode).toBe(200);
      expect((await request(1, "POST", "/me/push-test", { device_id: registered.json().id })).statusCode).toBe(200);
      expect(sent[0].platform).toBe("android");
      expect((await request(1, "POST", "/me/push-devices", { platform: "web", token: "disabled-web-token-" + uid() })).statusCode).toBe(409);
      expect((await inspectPushSettings({ GOOGLE_APPLICATION_CREDENTIALS: file, FIREBASE_PROJECT_ID: "wrong-project" })).ready).toBe(false);
    } finally { await unlink(file).catch(() => {}); await rmdir(directory); }
  });
  it("rejects registration from a stale account after the user changes", async () => {
    expect((await request(1, "POST", "/me/push-devices", { token: "wrong-user-token-" + uid(), user_id: users[0] })).statusCode).toBe(403);
    expect(await db.query("SELECT * FROM push_devices")).toHaveLength(0);
  });
  it("accepts hosted service-account JSON without exposing it through the API", async () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const credential = JSON.stringify({ type: "service_account", project_id: web.projectId, client_email: `rcs-push@${web.projectId}.iam.gserviceaccount.com`, private_key: key });
    state = await inspectPushSettings({ FIREBASE_SERVICE_ACCOUNT_JSON: credential, FIREBASE_PROJECT_ID: web.projectId });
    expect(state).toMatchObject({ ready: true, androidReady: true, webReady: false });
    const me = (await request(1, "GET", "/auth/me")).json();
    expect(me.push_android_ready).toBe(true);
    expect(JSON.stringify(me)).not.toContain("PRIVATE KEY");
    expect((await inspectPushSettings({ FIREBASE_SERVICE_ACCOUNT_JSON: credential, FIREBASE_PROJECT_ID: "different-project" })).ready).toBe(false);
  });
  it("does not retry web deliveries while only the Android transport is configured", async () => {
    for (let i = 0; i < 21; i++) await device();
    await request(1, "POST", "/me/push-devices", { platform: "android", token: "native-queue-token-" + uid() });
    await db.tx((sql) => notify(sql, [users[1]], "Событие RCS", "Смена изменена"));
    state = { ...configured, androidReady: true, webReady: false };
    await tick(db, gateway);
    expect(sent).toHaveLength(1);
    expect(sent[0].platform).toBe("android");
    expect((await db.query("SELECT attempts FROM deliveries d JOIN push_devices p ON p.id=d.device_id WHERE p.platform='web'"))[0].attempts).toBe(0);
  });
});
describe("Device setup and actual transport invocation", () => {
  it("formats dates only in notification text, including older notification history", async () => {
    await device();
    await db.tx((sql) => notify(sql, [users[1]], "Вам назначена смена", "2026-11-02 · 08:00–15:00"));
    expect((await db.query("SELECT body FROM notifications"))[0].body).toBe("02.11.2026 · 08:00–15:00");
    await db.query("UPDATE notifications SET body='2026-11-02 · 08:00–15:00'");
    expect((await request(1, "GET", "/notifications")).json()[0].body).toBe("02.11.2026 · 08:00–15:00");
  });
  it("suppresses old queued team/type notices while preserving manual announcements", async () => {
    await device();
    await db.tx(async (sql) => {
      for (const [title, link] of [["Команда обновлена", "employees"], ["Типы смен обновлены", "types"], ["Новый сотрудник", "employees"]]) await notify(sql, [users[1]], title, "Служебная запись", "admin", link);
      await notify(sql, [users[1]], "Сообщение управляющего", "Завтра открываемся в 09:00", "admin", "notifications");
    });
    await tick(db, gateway);
    expect(sent.map((message) => message.title)).toEqual(["Сообщение управляющего"]);
    expect(await db.query("SELECT * FROM notifications")).toHaveLength(4);
    expect((await request(1, "GET", "/notifications")).json().map((notice: any) => notice.title)).toEqual(["Сообщение управляющего"]);
    expect(await db.query("SELECT * FROM deliveries")).toHaveLength(1);
  });
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
