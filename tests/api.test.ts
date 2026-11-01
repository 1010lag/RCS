import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { hash } from "@node-rs/argon2";
import sharp from "sharp";
import { openDatabase, type Database } from "../server/db";
import { createApp } from "../server/app";
import { uid, localDate, amount } from "../server/domain";
import { tick } from "../server/worker";
import type { FastifyInstance } from "fastify";
import type { PushSettings } from "../server/push";
let db: Database,
  app: FastifyInstance,
  ids: string[],
  typeId: string,
  passwordHash: string,
  clock: Date;
const day = new Date(Date.parse(localDate()) + 7 * 86400000)
  .toISOString()
  .slice(0, 10);
type Client = { cookie: string; csrf: string };
let admin: Client, a: Client, b: Client, c: Client;
let loginAttempt = 0;
async function login(i: number) {
  const r = await app.inject({
    remoteAddress: "127.0.1." + ++loginAttempt,
    method: "POST",
    url: "/api/auth/login",
    payload: { phone: `+37529000000${i}`, password: "TestPassword!2026" },
  });
  expect(r.statusCode).toBe(200);
  return {
    cookie: r.headers["set-cookie"]!.toString().split(";")[0],
    csrf: r.json().csrf,
  };
}
async function call(
  client: Client,
  method: any,
  path: string,
  body?: any,
  key?: string,
) {
  const response = await app.inject({
    method,
    remoteAddress: `127.0.2.${Math.floor(loginAttempt / 4) % 250 + 1}`,
    url: "/api" + path,
    headers: {
      cookie: client.cookie,
      "x-csrf-token": client.csrf,
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body !== undefined ? { payload: body } : {}),
  });
  if (response.headers["x-csrf-token"]) {
    client.cookie = response.headers["set-cookie"]!.toString().split(";")[0];
    client.csrf = String(response.headers["x-csrf-token"]);
  }
  return response;
}
async function shift(userId = ids[1], extra: any = {}) {
  const r = await call(admin, "POST", "/shifts", {
    date: day,
    start_time: "20:00",
    end_time: "22:00",
    type_id: typeId,
    user_id: userId,
    status: "confirmed",
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
async function list(id: string, client = a) {
  const r = await call(client, "POST", `/shifts/${id}/exchange`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
async function quote(id: string, client = b) {
  const r = await call(client, "GET", `/exchange/${id}/quote`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    if (!url.pathname.endsWith("_test"))
      throw new Error(
        "TEST_DATABASE_URL must name a dedicated database ending in _test: tests truncate its tables",
      );
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = await openDatabase();
  } else db = await openDatabase(":memory:");
  passwordHash = await hash("TestPassword!2026");
  app = await createApp(db, {
    clock: () => clock,
    push: {
      settings: async () =>
        ({
          ready: true,
          status: "ready",
          issues: [],
          config: null,
          vapidKey: null,
          origin: null,
        }) as PushSettings,
      send: async () => "test-message",
    },
  });
  await app.ready();
});
beforeEach(async () => {
  clock = new Date(`${day}T10:00:00+03:00`);
  ids = [uid(), uid(), uid(), uid()];
  typeId = uid();
  await db.tx(async (sql) => {
    await sql.query("TRUNCATE users,shift_types,request_limits CASCADE");
    for (let i = 0; i < 4; i++)
      await sql.query(
        "INSERT INTO users(id,name,phone,role,password_hash,rate) VALUES($1,$2,$3,$4,$5,$6)",
        [
          ids[i],
          ["Админ", "Анна", "Максим", "София"][i],
          `+37529000000${i}`,
          i === 0 ? "admin" : "barista",
          passwordHash,
          12 + i * 2,
        ],
      );
    await sql.query(
      "INSERT INTO shift_types(id,name,start_time,end_time,pay_type,rate) VALUES($1,'Закрытие','20:00','22:00','hourly',12)",
      [typeId],
    );
  });
  [admin, a, b, c] = await Promise.all([
    login(0),
    login(1),
    login(2),
    login(3),
  ]);
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});
describe("Server permissions and privacy", () => {
  it("serves all administrative read models", async () => {
    for (const path of [
      `/schedule?from=${day}&to=${day}`,
      "/shift-types",
      "/employees",
      `/payroll?from=${day}&to=${day}`,
      "/audit-logs",
    ]) {
      const r = await call(admin, "GET", path);
      expect(r.statusCode, r.body).toBe(200);
    }
  });
  it("denies admin routes and spoofed role", async () => {
    for (const path of ["/employees", "/payroll", "/audit-logs"])
      expect((await call(a, "GET", path)).statusCode).toBe(403);
    expect(
      (await call(a, "POST", "/shifts", { role: "admin" })).statusCode,
    ).toBe(403);
    expect((await call(a, "POST", "/shift-types", {})).statusCode).toBe(403);
  });
  it("does not expose salary in common schedule, foreign detail, type list or user_id override", async () => {
    const id = await shift();
    const schedule = (
      await call(b, "GET", `/schedule?from=${day}&to=${day}`)
    ).json();
    expect(schedule[0]).not.toHaveProperty("rate");
    expect(schedule[0]).not.toHaveProperty("minutes");
    expect((await call(b, "GET", `/shifts/${id}`)).json()).not.toHaveProperty(
      "amount",
    );
    expect((await call(b, "GET", "/shift-types")).json()[0]).not.toHaveProperty(
      "rate",
    );
    expect(
      (
        await call(
          b,
          "GET",
          `/me/payroll?from=${day}&to=${day}&user_id=${ids[1]}`,
        )
      ).json(),
    ).toEqual([]);
    expect((await call(a, "GET", `/shifts/${id}`)).json().rate).toBe("14.00");
  });
  it("requires CSRF on mutations and disallows untrusted origins on login", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: { cookie: a.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: "https://attacker.example" },
          payload: { phone: "+375290000001", password: "TestPassword!2026" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("revokes an inactive user session immediately", async () => {
    await db.query("UPDATE users SET active=false WHERE id=$1", [ids[1]]);
    expect((await call(a, "GET", "/auth/me")).statusCode).toBe(401);
  });
});
describe("Archiving employees and shift types", () => {
  async function archiveEmployee(index: number, client = admin, version = 1) {
    const employee = (await db.query("SELECT name,phone,rate::text,pay_type FROM users WHERE id=$1", [ids[index]]))[0];
    return call(client, "PATCH", `/employees/${ids[index]}`, {
      ...employee, active: false, version, reason: "Сотрудник уволился",
    });
  }
  it("revokes access while keeping past shifts, adjustments and payroll", async () => {
    const yesterday = new Date(Date.parse(localDate()) - 86400000).toISOString().slice(0, 10);
    const id = await shift(ids[1], { date: yesterday, start_time: "08:00", end_time: "10:00", status: "worked" });
    await call(admin, "POST", `/shifts/${id}/adjustments`, { minutes: 30, amount: "3.00", reason: "Дополнительная работа" });
    await call(a, "POST", "/me/push-devices", { token: "archive-test-device-registration-token", platform: "android" });
    const payroll = (await call(admin, "GET", `/payroll?from=${yesterday}&to=${yesterday}`)).json();
    const result = await archiveEmployee(1);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().active).toBe(false);
    expect((await call(a, "GET", "/auth/me")).statusCode).toBe(401);
    expect((await call(admin, "GET", "/team")).json().some((u: any) => u.id === ids[1])).toBe(false);
    expect((await call(admin, "GET", `/schedule?from=${yesterday}&to=${yesterday}`)).json().some((s: any) => s.id === id)).toBe(true);
    expect((await db.query("SELECT * FROM users WHERE id=$1", [ids[1]]))).toHaveLength(1);
    expect((await db.query("SELECT * FROM adjustments WHERE shift_id=$1", [id]))).toHaveLength(1);
    expect((await db.query("SELECT * FROM sessions WHERE user_id=$1", [ids[1]]))).toHaveLength(0);
    expect((await db.query("SELECT * FROM push_devices WHERE user_id=$1", [ids[1]]))).toHaveLength(0);
    expect((await call(admin, "GET", `/payroll?from=${yesterday}&to=${yesterday}`)).json()).toEqual(payroll);
    expect((await db.query("SELECT action,reason FROM audit_logs WHERE entity_id=$1 ORDER BY created_at DESC", [ids[1]]))[0]).toMatchObject({ action: "Сотрудник удалён из команды", reason: "Сотрудник уволился" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "+375290000001", password: "TestPassword!2026" } });
    expect(login.statusCode).toBe(401);
  });
  it("checks admin rights, version and the last administrator", async () => {
    expect((await archiveEmployee(1, a)).statusCode).toBe(403);
    expect((await archiveEmployee(1, admin, 99)).statusCode).toBe(409);
    expect((await call(a, "GET", "/auth/me")).statusCode).toBe(200);
    expect((await archiveEmployee(0)).json().code).toBe("LAST_ADMIN");
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [ids[2]]);
    expect((await archiveEmployee(0)).json().code).toBe("SELF_DELETE");
  });
  it("finishes the current shift at dismissal, cancels only future shifts and keeps worked history visible", async () => {
    const current = await shift(ids[1], { start_time: "08:00", end_time: "12:00" });
    const future = await shift(), listing = await list(future);
    const unaffected = await shift(ids[2]);
    clock = new Date(`${day}T10:37:45+03:00`);
    const result = await archiveEmployee(1);
    expect(result.statusCode, result.body).toBe(200);
    for (const id of [future]) {
      const saved = (await db.query("SELECT status,version FROM shifts WHERE id=$1", [id]))[0];
      expect(saved.status).toBe("cancelled");
      expect(saved.version).toBeGreaterThan(1);
      expect((await db.query("SELECT * FROM audit_logs WHERE entity_id=$1 AND action='Смена отменена при удалении сотрудника'", [id]))).toHaveLength(1);
    }
    const shortened = (await db.query("SELECT status,end_at FROM shifts WHERE id=$1", [current]))[0];
    expect(shortened.status).toBe("confirmed");
    expect(new Date(shortened.end_at).toISOString()).toBe(new Date(`${day}T10:37:00+03:00`).toISOString());
    expect((await db.query("SELECT id FROM audit_logs WHERE entity_id=$1 AND action='Смена завершена досрочно при удалении сотрудника'", [current]))).toHaveLength(1);
    const pay = (await call(admin, "GET", `/payroll?from=${day}&to=${day}&user_id=${ids[1]}`)).json()[0];
    expect(pay).toMatchObject({ minutes: 157, amount: "36.63", planned_minutes: 0 });
    expect((await db.query("SELECT status FROM exchange_listings WHERE id=$1", [listing]))[0].status).toBe("cancelled");
    for (const client of [admin, b]) {
      const schedule = (await call(client, "GET", `/schedule?from=${day}&to=${day}`)).json();
      expect(schedule.map((shift: any) => shift.id)).toEqual([current, unaffected]);
      expect((await call(client, "GET", "/exchange")).json().some((entry: any) => entry.id === listing)).toBe(false);
    }
  });
  it("archives a shift type, closes its listings and keeps existing shift pay", async () => {
    const id = await shift(), listing = await list(id);
    const original = (await call(a, "GET", `/shifts/${id}`)).json();
    const body = { name: "Закрытие", start_time: "20:00", end_time: "22:00", pay_type: "hourly", rate: "12.00", allow_exchange: true, active: false, version: 1 };
    expect((await call(a, "PATCH", `/shift-types/${typeId}`, body)).statusCode).toBe(403);
    const result = await call(admin, "PATCH", `/shift-types/${typeId}`, body);
    expect(result.statusCode, result.body).toBe(200);
    expect((await call(a, "GET", "/shift-types")).json()).toEqual([]);
    expect((await call(admin, "GET", "/shift-types")).json()[0].active).toBe(false);
    expect((await call(a, "GET", `/shifts/${id}`)).json()).toMatchObject({ amount: original.amount, rate: original.rate, user_id: original.user_id, type_name: "Закрытие" });
    expect((await db.query("SELECT status FROM exchange_listings WHERE id=$1", [listing]))[0].status).toBe("cancelled");
    expect((await call(admin, "PATCH", `/shift-types/${typeId}`, body)).statusCode).toBe(409);
    const attempt = await call(admin, "POST", "/shifts", { date: day, start_time: "08:00", end_time: "10:00", type_id: typeId, user_id: ids[2] });
    expect(attempt.json().code).toBe("INACTIVE_TYPE");
  });
});

describe("Account credentials and shared avatars", () => {
  it("lets a barista change only their own full name and updates the calendar without changing pay", async () => {
    const id = await shift();
    const before = (await call(a, "GET", `/shifts/${id}`)).json();
    const result = await call(a, "PATCH", "/me/name", { name: "  Анна   Новая  ", version: 1, user_id: ids[2], role: "admin", rate: "999.00" });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ name: "Анна Новая", role: "barista", rate: "14.00" });
    expect((await db.query("SELECT name FROM users WHERE id=$1", [ids[2]]))[0].name).toBe("Максим");
    expect((await call(b, "GET", "/team")).json().find((u: any) => u.id === ids[1]).name).toBe("Анна Новая");
    expect((await call(b, "GET", `/schedule?from=${day}&to=${day}`)).json()[0].user_name).toBe("Анна Новая");
    expect((await call(a, "GET", `/shifts/${id}`)).json()).toMatchObject({ rate: before.rate, amount: before.amount });
    expect((await call(a, "PATCH", "/me/name", { name: "Другой", version: 1 })).statusCode).toBe(409);
    expect((await call(a, "PATCH", "/me/name", { name: "   ", version: 2 })).statusCode).toBe(422);
  });
  async function edit(index: number, client: Client, extra: Record<string, unknown> = {}) {
    const record = (await db.query("SELECT name,phone,rate::text,pay_type,active,version FROM users WHERE id=$1", [ids[index]]))[0];
    return call(client, "PATCH", `/employees/${ids[index]}`, { ...record, reason: "Обновление данных для входа", ...extra });
  }
  async function signIn(phone: string, password: string) {
    return app.inject({ method: "POST", url: "/api/auth/login", payload: { phone, password } });
  }
  it("rotates admin credentials and revokes every copied old session", async () => {
    const otherSession = await login(0);
    const stolen = { ...admin };
    const result = await edit(0, admin, { phone: "+375299999901", password: "OwnNewPassword!2026", current_password: "TestPassword!2026" });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ phone: "+375299999901", must_change_password: false });
    expect((await call(admin, "GET", "/auth/me")).statusCode).toBe(200);
    expect(admin.cookie).not.toBe(stolen.cookie);
    expect((await call(stolen, "GET", "/auth/me")).statusCode).toBe(401);
    expect((await call(otherSession, "GET", "/auth/me")).statusCode).toBe(401);
    expect((await signIn("+375290000000", "TestPassword!2026")).statusCode).toBe(401);
    expect((await signIn("+375299999901", "TestPassword!2026")).statusCode).toBe(401);
    expect((await signIn("+375299999901", "OwnNewPassword!2026")).statusCode).toBe(200);
  });
  it("lets an admin reset employee credentials and rejects a barista reset", async () => {
    expect((await edit(1, a, { password: "SpoofedPassword!2026" })).statusCode).toBe(403);
    const result = await edit(1, admin, { phone: "+375299999902", password: "ResetEmployee!2026", current_password: "TestPassword!2026" });
    expect(result.statusCode, result.body).toBe(200);
    expect((await call(a, "GET", "/auth/me")).statusCode).toBe(401);
    const session = await signIn("+375299999902", "ResetEmployee!2026");
    expect(session.statusCode, session.body).toBe(200);
    expect(session.json().user.must_change_password).toBe(true);
    const logs = JSON.stringify(await db.query("SELECT before_value,after_value FROM audit_logs"));
    expect(logs).not.toContain("ResetEmployee!2026");
    expect(logs).not.toContain("password_hash");
  });
  it("stores an avatar on the server and exposes it in the team and all calendar views", async () => {
    const id = await shift();
    const png = await sharp({ create: { width: 48, height: 80, channels: 3, background: "#e10600" } }).png().toBuffer();
    const result = await call(a, "PUT", "/me/avatar", { image: `data:image/png;base64,${png.toString("base64")}`, user_id: ids[2] });
    expect(result.statusCode, result.body).toBe(200);
    const avatar = result.json().avatar_url;
    expect(avatar).toMatch(/^data:image\/webp;base64,/);
    const metadata = await sharp(Buffer.from(avatar.split(",")[1], "base64")).metadata();
    expect(metadata).toMatchObject({ width: 256, height: 256, format: "webp" });
    expect((await db.query("SELECT avatar_url FROM users WHERE id=$1", [ids[2]]))[0].avatar_url).toBeNull();
    expect((await call(b, "GET", "/team")).json().find((u: any) => u.id === ids[1]).avatar_url).toBe(avatar);
    expect((await call(b, "GET", `/schedule?from=${day}&to=${day}`)).json()[0].user_avatar_url).toBe(avatar);
    expect((await call(a, "GET", `/shifts/${id}`)).json().user_avatar_url).toBe(avatar);
    const logs = JSON.stringify(await db.query("SELECT before_value,after_value FROM audit_logs"));
    expect(logs).not.toContain(avatar);
    expect((await call(a, "PUT", "/me/avatar", { image: null })).json().avatar_url).toBeNull();
    expect((await call(b, "GET", "/team")).json().find((u: any) => u.id === ids[1]).avatar_url).toBeNull();
  });
  it("rejects unsafe, corrupt and oversized avatar payloads", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>').toString("base64");
    for (const image of ["https://example.com/avatar.png", "data:image/png;base64,bm90IGFuIGltYWdl", `data:image/png;base64,${svg}`]) {
      expect((await call(a, "PUT", "/me/avatar", { image })).statusCode).toBe(422);
    }
    expect((await call(a, "PUT", "/me/avatar", { image: "A".repeat(410000) })).statusCode).toBe(413);
    expect((await db.query("SELECT avatar_url FROM users WHERE id=$1", [ids[1]]))[0].avatar_url).toBeNull();
  });
});

describe("Security regressions", () => {
  async function edit(index: number, extra: Record<string, unknown> = {}) {
    const record = (await db.query("SELECT name,phone,rate::text,pay_type,active,version FROM users WHERE id=$1", [ids[index]]))[0];
    return call(admin, "PATCH", `/employees/${ids[index]}`, { ...record, reason: "Проверка защиты доступа", ...extra });
  }
  it("requires the current password for credential changes and cannot reset another administrator", async () => {
    expect((await edit(0, { password: "DifferentPassword!2026" })).json().code).toBe("REAUTH_REQUIRED");
    expect((await edit(0, { password: "DifferentPassword!2026", current_password: "wrong" })).json().code).toBe("REAUTH_FAILED");
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [ids[2]]);
    expect((await edit(2, { password: "DifferentPassword!2026", current_password: "TestPassword!2026" })).json().code).toBe("ADMIN_CREDENTIALS_FORBIDDEN");
    expect((await edit(2, { phone: "+375299999777", current_password: "TestPassword!2026" })).statusCode).toBe(403);
    expect((await call(admin, "POST", "/employees", { name: "Второй админ", phone: "+375299999778", role: "admin", password: "DifferentPassword!2026" })).json().code).toBe("REAUTH_REQUIRED");
  });
  it("limits an account across changing client IPs and retains the block after an API restart", async () => {
    for (let i = 0; i < 8; i++) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: `192.0.2.${i + 1}`, headers: { "x-forwarded-for": `203.0.113.${i + 1}` }, payload: { phone: "+375290000001", password: "wrong" } });
      expect(response.statusCode).toBe(401);
    }
    const restarted = await createApp(db);
    try {
      const response = await restarted.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "192.0.2.99", payload: { phone: "+375290000001", password: "TestPassword!2026" } });
      expect(response.statusCode).toBe(429);
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    } finally { await restarted.close(); }
  });
  it("ignores spoofed forwarded IPs by default", async () => {
    for (let i = 0; i < 21; i++) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "192.0.2.200", headers: { "x-forwarded-for": `203.0.113.${i + 1}` }, payload: { phone: `+37529999${String(i).padStart(4, "0")}`, password: "wrong" } });
      expect(response.statusCode).toBe(i < 20 ? 401 : 429);
    }
  });
  it("bounds expensive avatar and password work per account", async () => {
    for (let i = 0; i < 4; i++) expect((await call(a, "PUT", "/me/avatar", { image: "data:image/png;base64,bm90YW5pbWFnZQ==" })).statusCode).toBe(i < 3 ? 422 : 429);
    for (let i = 0; i < 6; i++) expect((await call(b, "POST", "/auth/password", { current: "wrong", password: "NewPassword!2026" })).statusCode).toBe(i < 5 ? 403 : 429);
  });
  it("finishes concurrent account creation and login without holding CPU slots while waiting for the database", async () => {
    const create = call(admin, "POST", "/employees", { name: "Параллельный вход", phone: "+375299999770", password: "ConcurrentPassword!2026" });
    const logins = [1, 2, 3].map((index) => login(index));
    expect((await create).statusCode).toBe(200);
    await Promise.all(logins);
    expect((await app.inject("/api/health")).statusCode).toBe(200);
  });
  it("revokes all push devices and stolen cookies on a password change", async () => {
    const other = await login(1), stolen = { ...a };
    for (const [client, token] of [[a, "x".repeat(40)], [other, "y".repeat(40)]] as const) {
      expect((await call(client, "POST", "/me/push-devices", { token })).statusCode).toBe(200);
    }
    expect((await call(a, "POST", "/auth/password", { current: "TestPassword!2026", password: "ChangedPassword!2026" })).statusCode).toBe(200);
    expect((await call(a, "GET", "/auth/me")).statusCode).toBe(200);
    expect((await call(stolen, "GET", "/auth/me")).statusCode).toBe(401);
    expect((await call(other, "GET", "/auth/me")).statusCode).toBe(401);
    expect(await db.query("SELECT * FROM push_devices WHERE user_id=$1", [ids[1]])).toHaveLength(0);
  });
  it("does not deliver queued push to an expired session", async () => {
    await call(a, "POST", "/me/push-devices", { token: "expired-device-token".repeat(2) });
    await call(admin, "POST", "/admin/notifications", { title: "Конфиденциально", body: "Текст только для действующей сессии", user_id: ids[1] });
    expect(await db.query("SELECT * FROM deliveries")).toHaveLength(1);
    await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [ids[1]]);
    const sent: unknown[] = [];
    await tick(db, { settings: async () => ({ ready: true }) as PushSettings, send: async (message) => { sent.push(message); return "fake"; } });
    expect(sent).toEqual([]);
    expect(await db.query("SELECT * FROM push_devices")).toHaveLength(0);
    expect(await db.query("SELECT * FROM deliveries")).toHaveLength(0);
  });
});

describe("Personal adjustments and exchange notifications", () => {
  it("keeps a future personal bonus with its beneficiary and blocks every owner-transfer path", async () => {
    const id = await shift(), listing = await list(id), before = await quote(listing);
    expect((await call(admin, "POST", `/shifts/${id}/adjustments`, { minutes: 0, amount: "50.00", reason: "Премия Анне" })).statusCode).toBe(200);
    expect((await db.query("SELECT status FROM exchange_listings WHERE id=$1", [listing]))[0].status).toBe("cancelled");
    expect((await call(a, "POST", `/shifts/${id}/exchange`)).json().code).toBe("ADJUSTED_OWNER");
    expect((await call(b, "POST", `/exchange/${listing}/take`, { version: before.version }, uid())).statusCode).toBe(409);
    const saved = (await call(admin, "GET", `/shifts/${id}`)).json();
    expect((await call(admin, "PATCH", `/shifts/${id}`, { date: day, start_time: saved.start_time, end_time: saved.end_time, type_id: typeId, user_id: ids[2], version: saved.version, reason: "Переназначить смену" })).json().code).toBe("ADJUSTED_OWNER");
    expect((await call(a, "GET", `/me/payroll?from=${day}&to=${day}`)).json()[0].planned_amount).toBe("78.00");
    expect((await call(b, "GET", `/me/payroll?from=${day}&to=${day}`)).json()).toEqual([]);
  });
  it("blocks rollback after the recipient receives a correction", async () => {
    const id = await shift(), listing = await list(id), q = await quote(listing);
    await call(b, "POST", `/exchange/${listing}/take`, { version: q.version }, uid());
    await call(admin, "POST", `/shifts/${id}/adjustments`, { minutes: 30, amount: "5.00", reason: "Доплата Максиму" });
    const response = await call(admin, "POST", `/exchange/${listing}/rollback`, { reason: "Откат назначения" });
    expect(response.json().code).toBe("ADJUSTED_OWNER");
    expect((await call(b, "GET", `/me/payroll?from=${day}&to=${day}`)).json()[0].planned_amount).toBe("45.00");
  });
  it("credits already-transferred legacy money to the original employee, never to the current owner", async () => {
    const id = await shift();
    await db.query("INSERT INTO adjustments(id,shift_id,user_id,amount,reason,created_by) VALUES($1,$2,$3,50,'Старая премия',$4)", [uid(), id, ids[1], ids[0]]);
    await db.query("UPDATE shifts SET user_id=$1,rate=16 WHERE id=$2", [ids[2], id]);
    expect((await call(a, "GET", `/me/payroll?from=${day}&to=${day}`)).json()[0].planned_amount).toBe("50.00");
    expect((await call(b, "GET", `/me/payroll?from=${day}&to=${day}`)).json()[0].planned_amount).toBe("32.00");
    expect((await call(a, "GET", `/adjustments?shift_id=${id}`)).json()).toHaveLength(1);
    expect((await call(b, "GET", `/adjustments?shift_id=${id}`)).json()).toHaveLength(0);
    expect((await call(b, "GET", `/shifts/${id}`)).json().amount).toBe("32.00");
  });
  it("requires explicit reconciliation when the old hourly rate is unknown", async () => {
    const id = await shift(ids[2]), correction = uid();
    await db.query("INSERT INTO adjustments(id,shift_id,user_id,minutes,reason,created_by) VALUES($1,$2,$3,30,'Старые часы',$4)", [correction, id, ids[1], ids[0]]);
    expect((await call(a, "GET", `/me/payroll?from=${day}&to=${day}`)).json().code).toBe("ADJUSTMENT_REVIEW_REQUIRED");
    expect((await call(a, "PATCH", `/adjustments/${correction}/credit`, { amount: "7.00", reason: "Проверенная ставка 14 Br" })).statusCode).toBe(403);
    expect((await call(admin, "PATCH", `/adjustments/${correction}/credit`, { amount: "7.00", reason: "Проверенная ставка 14 Br" })).statusCode).toBe(200);
    expect((await call(a, "GET", `/me/payroll?from=${day}&to=${day}`)).json()[0].planned_amount).toBe("7.00");
    expect((await call(b, "GET", `/me/payroll?from=${day}&to=${day}`)).json()[0].planned_amount).toBe("32.00");
  });
  it("suppresses self notices, deduplicates republishing, and limits publication bursts", async () => {
    const id = await shift(), listing = await list(id);
    expect((await db.query("SELECT * FROM notifications WHERE user_id=$1 AND title='Новая смена на бирже'", [ids[1]]))).toHaveLength(0);
    await call(a, "POST", `/exchange/${listing}/withdraw`);
    expect((await call(a, "POST", `/shifts/${id}/exchange`)).statusCode).toBe(429);
    await db.query("UPDATE exchange_listings SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", [listing]);
    const again = await list(id);
    expect((await db.query("SELECT * FROM notifications WHERE user_id=$1 AND title='Новая смена на бирже'", [ids[2]]))).toHaveLength(1);
    await call(a, "POST", `/exchange/${again}/withdraw`);
    for (let i = 1; i <= 4; i++) {
      const nextDay = new Date(Date.parse(day) + i * 86400000).toISOString().slice(0, 10), next = await shift(ids[1], { date: nextDay });
      expect((await call(a, "POST", `/shifts/${next}/exchange`)).statusCode).toBe(i < 4 ? 200 : 429);
    }
  });
  it("sends a removal message to the old owner when an admin reassigns a shift", async () => {
    const id = await shift(), saved = (await call(admin, "GET", `/shifts/${id}`)).json();
    await db.query("DELETE FROM deliveries");
    await db.query("DELETE FROM notifications");
    expect((await call(admin, "PATCH", `/shifts/${id}`, { date: day, start_time: saved.start_time, end_time: saved.end_time, type_id: typeId, user_id: ids[2], version: saved.version, reason: "Переназначение" })).statusCode).toBe(200);
    const notices = await db.query("SELECT user_id,title FROM notifications ORDER BY user_id");
    expect(notices).toContainEqual({ user_id: ids[1], title: "Смена снята с вашего графика" });
    expect(notices).toContainEqual({ user_id: ids[2], title: "Вам назначена смена" });
    expect(notices.some((row) => row.title === "Ваша смена изменена")).toBe(false);
  });
  it("uses the Minsk day for requests without an explicit period after midnight", async () => {
    const id = await shift();
    clock = new Date(`${day}T00:30:00+03:00`);
    expect((await call(admin, "GET", "/schedule")).json().map((row: any) => row.id)).toContain(id);
    expect((await call(a, "GET", "/me/payroll")).json()[0].date).toBe(day);
  });
});

describe("Calendar and pay", () => {
  it("rejects overnight shifts, invalid dates and overlap; allows adjacent shifts", async () => {
    for (const extra of [
      { start_time: "22:00", end_time: "02:00" },
      { date: "2026-02-30" },
      { start_time: "20:00", end_time: "20:00" },
    ]) {
      const r = await call(admin, "POST", "/shifts", {
        date: day,
        start_time: "20:00",
        end_time: "22:00",
        type_id: typeId,
        user_id: ids[1],
        ...extra,
      });
      expect(r.statusCode).toBe(422);
    }
    await shift();
    expect(
      (
        await call(admin, "POST", "/shifts", {
          date: day,
          start_time: "21:00",
          end_time: "23:00",
          type_id: typeId,
          user_id: ids[1],
        })
      ).statusCode,
    ).toBe(409);
    await shift(ids[1], { start_time: "18:00", end_time: "20:00" });
  });
  it("calculates decimal hours without breaks and money with cent precision", () => {
    expect(amount(540, "12.00", "hourly")).toBe("108.00");
    expect(amount(525, "12.00", "hourly")).toBe("105.00");
    expect(amount(525, "85.00", "shift")).toBe("85.00");
    expect(amount(1, "0.30", "hourly")).toBe("0.01");
  });
  it("separates future plan from worked totals and sums multiple shifts", async () => {
    const yesterday = new Date(Date.parse(localDate()) - 86400000)
      .toISOString()
      .slice(0, 10);
    await shift(ids[1], {
      date: yesterday,
      start_time: "08:30",
      end_time: "17:15",
    });
    await shift(ids[1], {
      date: yesterday,
      start_time: "18:00",
      end_time: "19:00",
    });
    await shift();
    const past = (
      await call(a, "GET", `/me/payroll?from=${yesterday}&to=${yesterday}`)
    ).json()[0];
    expect(past.minutes).toBe(585);
    expect(past.amount).toBe("136.50");
    const planned = (
      await call(a, "GET", `/me/payroll?from=${day}&to=${day}`)
    ).json()[0];
    expect(planned.minutes).toBe(0);
    expect(planned.planned_amount).toBe("28.00");
  });
  it("requires adjustment reason and recalculates hourly amount", async () => {
    const id = await shift();
    expect(
      (
        await call(admin, "POST", `/shifts/${id}/adjustments`, {
          minutes: 30,
          amount: "5.00",
          reason: "",
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call(admin, "POST", `/shifts/${id}/adjustments`, {
          minutes: 30,
          amount: "5.00",
          reason: "Дополнительная работа",
        })
      ).statusCode,
    ).toBe(200);
    const row = (await call(a, "GET", `/shifts/${id}`)).json();
    expect(row.amount).toBe("40.00");
    expect(row.adjustment_minutes).toBe(30);
  });
  it("preserves saved pay when type rate or model changes", async () => {
    const id = await shift();
    await db.query(
      "UPDATE shift_types SET rate=100,pay_type='shift',version=version+1 WHERE id=$1",
      [typeId],
    );
    const s = (await call(admin, "GET", `/shifts/${id}`)).json();
    expect(
      (
        await call(admin, "PATCH", `/shifts/${id}`, {
          date: day,
          start_time: s.start_time,
          end_time: s.end_time,
          type_id: typeId,
          user_id: ids[1],
          status: "confirmed",
          version: s.version,
          reason: "Текст обновлён",
        })
      ).statusCode,
    ).toBe(200);
    const result = (await call(a, "GET", `/shifts/${id}`)).json();
    expect(result.rate).toBe("14.00");
    expect(result.pay_type).toBe("hourly");
  });
});
describe("Atomic exchange", () => {
  it("accepts Android's empty form POST for listing and withdrawing a shift", async () => {
    const id = await shift();
    const post = (path: string, client = a, payload = "") => app.inject({
      method: "POST",
      url: `/api${path}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: client.cookie,
        "x-csrf-token": client.csrf,
      },
      payload,
    });
    const listed = await post(`/shifts/${id}/exchange`);
    expect(listed.statusCode, listed.body).toBe(200);
    const withdrawn = await post(`/exchange/${listed.json().id}/withdraw`);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect((await call(a, "GET", `/shifts/${id}`)).json().exchange_id).toBeNull();
    expect((await post(`/shifts/${id}/exchange`, b)).statusCode).toBe(403);
    expect((await post(`/shifts/${id}/exchange`, { ...a, csrf: "wrong" })).statusCode).toBe(403);
    expect((await post(`/shifts/${id}/exchange`, a, "unexpected=value")).statusCode).toBe(415);
  });
  it("transfers immediately, recalculates recipient rate, prevents repeat listing and deduplicates retry", async () => {
    const id = await shift(),
      l = await list(id),
      q = await quote(l),
      key = uid();
    expect(q.rate).toBe("16.00");
    const r = await call(
      b,
      "POST",
      `/exchange/${l}/take`,
      { version: q.version },
      key,
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (
        await call(
          b,
          "POST",
          `/exchange/${l}/take`,
          { version: q.version },
          key,
        )
      ).json(),
    ).toEqual(r.json());
    const s = (await call(b, "GET", `/shifts/${id}`)).json();
    expect(s.user_id).toBe(ids[2]);
    expect(s.amount).toBe("32.00");
    expect((await call(b, "POST", `/shifts/${id}/exchange`)).statusCode).toBe(
      409,
    );
    expect(
      (
        await db.query(
          "SELECT count(*)::integer AS n FROM audit_logs WHERE action='Смена забрана с биржи'",
        )
      )[0].n,
    ).toBe(1);
  });
  it("only one of two simultaneous takers wins", async () => {
    const id = await shift(),
      l = await list(id),
      qb = await quote(l, b),
      qc = await quote(l, c);
    const results = await Promise.all([
      call(b, "POST", `/exchange/${l}/take`, { version: qb.version }, uid()),
      call(c, "POST", `/exchange/${l}/take`, { version: qc.version }, uid()),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().code).toBe(
      "EXCHANGE_ALREADY_TAKEN",
    );
  });
  it("prevents a taker from receiving overlapping shifts even across two listings", async () => {
    const s1 = await shift(ids[1]),
      s2 = await shift(ids[3]);
    const l1 = await list(s1, a),
      l2 = await list(s2, c),
      q1 = await quote(l1, b),
      q2 = await quote(l2, b);
    const results = await Promise.all([
      call(b, "POST", `/exchange/${l1}/take`, { version: q1.version }, uid()),
      call(b, "POST", `/exchange/${l2}/take`, { version: q2.version }, uid()),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().code).toBe(
      "SHIFT_OVERLAP",
    );
  });
  it("uses the shift day deadline, rejecting exactly 19:00 and exactly start", async () => {
    const id = await shift(),
      l = await list(id),
      q = await quote(l);
    clock = new Date(`${day}T18:59:59+03:00`);
    expect((await call(b, "GET", `/exchange/${l}/quote`)).statusCode).toBe(200);
    clock = new Date(`${day}T19:00:00+03:00`);
    const late = await call(
      b,
      "POST",
      `/exchange/${l}/take`,
      { version: q.version },
      uid(),
    );
    expect(late.json().code).toBe("EXCHANGE_DEADLINE_PASSED");
    const early = await shift(ids[3], {
      start_time: "11:00",
      end_time: "13:00",
    });
    clock = new Date(`${day}T11:00:00+03:00`);
    expect(
      (await call(c, "POST", `/shifts/${early}/exchange`)).json().code,
    ).toBe("SHIFT_STARTED");
  });
  it("rejects stale pay quote after individual rate changes", async () => {
    const id = await shift(),
      l = await list(id),
      q = await quote(l);
    await db.query("UPDATE users SET rate=25,version=version+1 WHERE id=$1", [
      ids[2],
    ]);
    expect(
      (
        await call(
          b,
          "POST",
          `/exchange/${l}/take`,
          { version: q.version },
          uid(),
        )
      ).json().code,
    ).toBe("QUOTE_CHANGED");
  });
  it("requires owner, rejects self-take and supports audited rollback", async () => {
    const id = await shift();
    expect((await call(b, "POST", `/shifts/${id}/exchange`)).statusCode).toBe(
      403,
    );
    const l = await list(id),
      qOwn = await quote(l, a);
    expect(
      (
        await call(
          a,
          "POST",
          `/exchange/${l}/take`,
          { version: qOwn.version },
          uid(),
        )
      ).json().code,
    ).toBe("OWN_SHIFT");
    const q = await quote(l);
    await call(b, "POST", `/exchange/${l}/take`, { version: q.version }, uid());
    expect(
      (
        await call(admin, "POST", `/exchange/${l}/rollback`, {
          reason: "Ошибка при выборе смены",
        })
      ).statusCode,
    ).toBe(200);
    const s = (await call(a, "GET", `/shifts/${id}`)).json();
    expect(s.user_id).toBe(ids[1]);
    expect(s.rate).toBe("14.00");
    expect(s.exchanged).toBe(true);
  });
  it("type disabling closes listings without rewriting shifts", async () => {
    const id = await shift(),
      l = await list(id);
    expect(
      (
        await call(admin, "PATCH", `/shift-types/${typeId}`, {
          name: "Закрытие",
          start_time: "20:00",
          end_time: "22:00",
          pay_type: "hourly",
          rate: "30.00",
          allow_exchange: false,
          active: true,
          version: 1,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await db.query("SELECT status FROM exchange_listings WHERE id=$1", [l])
      )[0].status,
    ).toBe("cancelled");
    expect((await call(a, "GET", `/shifts/${id}`)).json().rate).toBe("14.00");
  });
});
describe("Individual hourly rates", () => {
  it("creates hourly types without a type rate and calculates pay only from the employee rate", async () => {
    const result = await call(admin, "POST", "/shift-types", { name: "Без ставки типа", start_time: "20:00", end_time: "22:00" });
    expect(result.statusCode, result.body).toBe(200);
    const newType = result.json().id;
    expect((await db.query("SELECT pay_type,rate::text FROM shift_types WHERE id=$1", [newType]))[0]).toMatchObject({ pay_type: "hourly", rate: "0.00" });
    await db.query("UPDATE shift_types SET rate=999 WHERE id=$1", [newType]);
    const id = await shift(ids[1], { type_id: newType });
    expect((await call(a, "GET", `/shifts/${id}`)).json()).toMatchObject({ rate: "14.00", amount: "28.00" });
    await db.query("UPDATE users SET rate=NULL WHERE id=$1", [ids[2]]);
    const failed = await call(admin, "POST", "/shifts", { date: day, start_time: "20:00", end_time: "22:00", type_id: newType, user_id: ids[2] });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().code).toBe("EMPLOYEE_RATE_REQUIRED");
    expect((await call(a, "GET", `/shifts/${id}`)).json().amount).toBe("28.00");
    expect((await call(admin, "POST", "/shift-types", { name: "Фиксированная", start_time: "08:00", end_time: "10:00", pay_type: "shift" })).json().code).toBe("FIXED_RATE_REQUIRED");
  });
  it("updates future hourly shifts but preserves past, fixed and manually overridden rates", async () => {
    const offset = (n: number) =>
      new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
    const past = await shift(ids[1], { date: offset(-1) });
    const future = await shift(),
      listing = await list(future);
    const manual = await shift(ids[1], {
      date: offset(1),
      rate_override: "27.00",
    });
    const fixedType = uid();
    await db.query(
      "INSERT INTO shift_types(id,name,start_time,end_time,pay_type,rate) VALUES($1,'Фиксированная','20:00','22:00','shift',80)",
      [fixedType],
    );
    const fixed = await shift(ids[1], { date: offset(2), type_id: fixedType });
    const r = await call(admin, "PATCH", `/employees/${ids[1]}/hourly-rate`, {
      rate: "22.50",
      version: 1,
      apply_to_future: true,
      reason: "Повышение квалификации",
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().updated_shifts).toBe(1);
    for (const [id, rate] of [
      [past, "14.00"],
      [future, "22.50"],
      [manual, "27.00"],
      [fixed, "80.00"],
    ])
      expect((await call(a, "GET", `/shifts/${id}`)).json().rate).toBe(rate);
    expect(
      (
        await db.query("SELECT status FROM exchange_listings WHERE id=$1", [
          listing,
        ])
      )[0].status,
    ).toBe("cancelled");
    const created = await shift(ids[1], { date: offset(3) });
    expect((await call(a, "GET", `/shifts/${created}`)).json().amount).toBe(
      "45.00",
    );
    expect(
      (
        await db.query(
          "SELECT reason FROM audit_logs WHERE action='Почасовая ставка сотрудника изменена'",
        )
      )[0].reason,
    ).toBe("Повышение квалификации");
  });
  it("can apply only to new shifts and denies barista changes, negative values and stale versions", async () => {
    const id = await shift(),
      body = {
        rate: "19.75",
        version: 1,
        apply_to_future: false,
        reason: "Изменение ставки",
      };
    expect(
      (await call(a, "PATCH", `/employees/${ids[1]}/hourly-rate`, body))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(admin, "PATCH", `/employees/${ids[1]}/hourly-rate`, {
          ...body,
          rate: "-1",
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await call(admin, "PATCH", `/employees/${ids[1]}/hourly-rate`, body))
        .statusCode,
    ).toBe(200);
    expect((await call(a, "GET", `/shifts/${id}`)).json().rate).toBe("14.00");
    expect(
      (await call(admin, "PATCH", `/employees/${ids[1]}/hourly-rate`, body))
        .statusCode,
    ).toBe(409);
    const fresh = await shift(ids[1], {
      start_time: "17:00",
      end_time: "19:00",
    });
    expect((await call(a, "GET", `/shifts/${fresh}`)).json().rate).toBe(
      "19.75",
    );
  });
});

describe("Worker", () => {
  it("registers multiple devices and only revokes the selected owned device", async () => {
    const first = (
      await call(a, "POST", "/me/push-devices", { token: "a".repeat(40) })
    ).json().id;
    const second = (
      await call(a, "POST", "/me/push-devices", { token: "b".repeat(40) })
    ).json().id;
    const foreign = (
      await call(b, "POST", "/me/push-devices", { token: "c".repeat(40) })
    ).json().id;
    expect(
      (await call(a, "DELETE", "/me/push-devices", { id: first })).statusCode,
    ).toBe(200);
    await call(a, "DELETE", "/me/push-devices", { id: foreign });
    expect(
      (await db.query("SELECT id FROM push_devices ORDER BY id"))
        .map((x) => x.id)
        .sort(),
    ).toEqual([second, foreign].sort());
  });
  it("expires listings while keeping owner and is safe to retry", async () => {
    const yesterday = new Date(Date.parse(localDate()) - 86400000)
        .toISOString()
        .slice(0, 10),
      id = await shift(ids[1], { date: yesterday }),
      l = uid();
    await db.query(
      "INSERT INTO exchange_listings(id,shift_id,listed_by,closes_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 day')",
      [l, id, ids[1]],
    );
    await tick(db);
    await tick(db);
    expect(
      (
        await db.query("SELECT status FROM exchange_listings WHERE id=$1", [l])
      )[0].status,
    ).toBe("expired");
    expect(
      (
        await db.query("SELECT user_id,status FROM shifts WHERE id=$1", [id])
      )[0],
    ).toEqual({ user_id: ids[1], status: "worked" });
    expect(
      (
        await db.query(
          "SELECT count(*)::integer AS n FROM notifications WHERE dedup_key=$1",
          [`expired:${l}:${ids[1]}`],
        )
      )[0].n,
    ).toBe(1);
  });
});
