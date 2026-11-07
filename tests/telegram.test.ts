import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../server/db";
import { createApp } from "../server/app";
import { notify, uid } from "../server/domain";
import { createTelegramLink, deliverTelegram, handleTelegramUpdate, telegramSettings, TelegramError, validateTelegramData, type TelegramGateway } from "../server/telegram";
import { nextWorkerDelay, tick } from "../server/worker";
import type { PushGateway } from "../server/push";

const token = "123456789:test_token_for_telegram_integration_12345";
let db: Database, app: FastifyInstance, user: string, other: string, csrf: string;
let sent: { chat: string; title: string; body: string }[] = [], error: TelegramError | null = null, updateId = 0;
const bot: TelegramGateway = { ready: () => true, send: async (chat, title, body) => { if (error) throw error; sent.push({ chat, title, body }); } };
const noPush: PushGateway = { settings: async () => ({ ready: false, status: "unconfigured", issues: [], config: null, vapidKey: null, origin: null }), send: async () => { throw new Error("Firebase must not be called"); } };
const previous = { ...process.env };
function signed(chat = 123456789, age = 0) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - age), query_id: "test-query", user: JSON.stringify({ id: chat, first_name: "Test" }) });
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", key).update(check).digest("hex"));
  return params.toString();
}
function update(text: string, chat = 123456789, id = ++updateId) {
  return { update_id: id, message: { from: { id: chat }, chat: { id: chat, type: "private" }, text } };
}
async function connect(id = user, chat = 123456789) {
  const link = await createTelegramLink(db, id);
  await handleTelegramUpdate(db, update("/start " + new URL(link.url).searchParams.get("start"), chat), bot);
  sent = [];
  return link;
}
async function request(method: any, path: string, body?: Record<string, unknown>) {
  return app.inject({ method, url: "/api" + path, headers: { cookie: "rcs_session=test-session", "x-csrf-token": csrf }, ...(body === undefined ? {} : { payload: body }) });
}
beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_BOT_USERNAME = "rcs_test_bot";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test_secret_123456789012345678901234567890";
  process.env.APP_ORIGIN = "https://rcs.example.com";
  db = await openDatabase(":memory:");
  app = await createApp(db, { push: noPush, telegram: bot });
});
beforeEach(async () => {
  await db.query("TRUNCATE users,shift_types,telegram_updates,request_limits CASCADE");
  user = uid(); other = uid(); csrf = "test-csrf"; sent = []; error = null;
  await db.query("INSERT INTO users(id,name,phone,password_hash,role) VALUES($1,'One','+375291234567','unused','barista'),($2,'Two','+375291234568','unused','barista')", [user, other]);
  const { telegramDigest } = await import("../server/telegram");
  await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')", [telegramDigest("test-session"), user, csrf]);
});
afterAll(async () => {
  await app?.close(); await db?.close();
  for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET", "APP_ORIGIN"])
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
});

describe("Telegram integration", () => {
  it("requires public HTTPS and never exposes server secrets in status", async () => {
    expect(telegramSettings().ready).toBe(true);
    expect(telegramSettings({ ...process.env, APP_ORIGIN: "http://localhost:5173" }).ready).toBe(false);
    const response = await request("GET", "/me/telegram");
    expect(response.json()).toMatchObject({ configured: true, connected: false });
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(process.env.TELEGRAM_WEBHOOK_SECRET);
  });
  it("checks signatures, timestamp freshness and duplicate parameters", () => {
    const raw = signed();
    expect(validateTelegramData(raw)).toBe("123456789");
    expect(() => validateTelegramData(raw.replace("Test", "Fake"))).toThrow();
    expect(() => validateTelegramData(signed(123456789, 601))).toThrow();
    expect(() => validateTelegramData(signed(123456789, -60))).toThrow();
    expect(() => validateTelegramData(raw + "&auth_date=1")).toThrow();
  });
  it("requires authentication and CSRF for link creation; stores only its hash", async () => {
    expect((await app.inject({ method: "POST", url: "/api/me/telegram/link" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/me/telegram/link", headers: { cookie: "rcs_session=test-session" } })).statusCode).toBe(403);
    const link = (await request("POST", "/me/telegram/link")).json();
    const saved = (await db.query("SELECT token_hash FROM telegram_links"))[0];
    expect(saved.token_hash).toHaveLength(64);
    expect(link.url).not.toContain(saved.token_hash);
    await connect();
    expect((await request("GET", "/me/telegram")).json().connected).toBe(true);
  });
  it("consumes a link once, rejects expired tokens, ignores group messages and duplicate updates", async () => {
    const link = await createTelegramLink(db, user), text = "/start " + new URL(link.url).searchParams.get("start");
    const group = update(text); group.message.chat.type = "group";
    await handleTelegramUpdate(db, group, bot);
    expect(await db.query("SELECT * FROM telegram_accounts")).toHaveLength(0);
    const message = update(text);
    await handleTelegramUpdate(db, message, bot);
    await handleTelegramUpdate(db, message, bot);
    expect(sent).toHaveLength(1);
    expect(await db.query("SELECT * FROM telegram_links")).toHaveLength(0);
    await handleTelegramUpdate(db, update(text, 987654321), bot);
    expect((await db.query("SELECT chat_id FROM telegram_accounts"))[0].chat_id).toBe("123456789");
    const expired = await createTelegramLink(db, other);
    await db.query("UPDATE telegram_links SET expires_at=clock_timestamp()-interval '1 second'");
    await handleTelegramUpdate(db, update("/start " + new URL(expired.url).searchParams.get("start"), 987654321), bot);
    expect(await db.query("SELECT * FROM telegram_accounts")).toHaveLength(1);
  });
  it("rejects webhook requests without the secret and never silently reassigns a Telegram account", async () => {
    expect((await app.inject({ method: "POST", url: "/api/telegram/webhook", payload: update("/start") })).statusCode).toBe(403);
    await connect();
    await connect(other);
    expect((await db.query("SELECT user_id FROM telegram_accounts"))[0].user_id).toBe(user);
    const response = await app.inject({ method: "POST", url: "/api/telegram/webhook", headers: { "x-telegram-bot-api-secret-token": process.env.TELEGRAM_WEBHOOK_SECRET }, payload: update("/stop") });
    expect(response.statusCode).toBe(200);
    expect(await db.query("SELECT * FROM telegram_accounts")).toHaveLength(0);
  });
  it("creates a session only for a linked active user; unlinking revokes Telegram sessions", async () => {
    expect((await request("POST", "/auth/telegram", { init_data: signed() })).statusCode).toBe(401);
    await connect();
    const response = await request("POST", "/auth/telegram", { init_data: signed() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().user.id).toBe(user);
    const cookie = response.headers["set-cookie"]!.toString().split(";")[0];
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(200);
    await request("DELETE", "/me/telegram");
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await request("GET", "/auth/me")).statusCode).toBe(200);
  });
  it("ignores retired password flags for Telegram linking, login and delivery", async () => {
    await db.query("UPDATE users SET must_change_password=true WHERE id=$1", [user]);
    await connect();
    const response = await request("POST", "/auth/telegram", { init_data: signed() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().user.must_change_password).toBe(false);
    await db.tx(sql => notify(sql, [user], "Проверка входа", "Смена доступна", "schedule"));
    await deliverTelegram(db, bot);
    expect(sent).toHaveLength(1);
  });
  it("delivers through the worker with Firebase disabled, deduplicates events and respects preferences", async () => {
    await connect();
    await db.tx(sql => notify(sql, [user], "Новая смена", "2026-11-04 · 08:00", "schedule", "schedule", "same"));
    await db.tx(sql => notify(sql, [user], "Новая смена", "2026-11-04 · 08:00", "schedule", "schedule", "same"));
    await tick(db, noPush, bot);
    await tick(db, noPush, bot);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat: "123456789", body: "04.11.2026 · 08:00" });
    await db.tx(sql => notify(sql, [user], "Изменение", "Тест"));
    await db.query("INSERT INTO preferences(user_id,schedule) VALUES($1,false)", [user]);
    await deliverTelegram(db, bot);
    expect(sent).toHaveLength(1);
  });
  it("persists transient failures and schedules a retry even with a long idle worker", async () => {
    await connect();
    await db.tx(sql => notify(sql, [user], "Тест", "Очередь"));
    error = new TelegramError("telegram/429", 90);
    await deliverTelegram(db, bot);
    const saved = (await db.query("SELECT attempts,last_error,EXTRACT(EPOCH FROM(next_attempt-clock_timestamp())) AS wait FROM telegram_deliveries"))[0];
    expect(saved.attempts).toBe(1); expect(saved.last_error).toBe("telegram/429"); expect(Number(saved.wait)).toBeGreaterThan(85);
    const delay = await nextWorkerDelay(db, 3600000, noPush, bot);
    expect(delay).toBeLessThan(91000);
    error = null;
    await db.query("UPDATE telegram_deliveries SET next_attempt=clock_timestamp()");
    await deliverTelegram(db, bot);
    expect(sent).toHaveLength(1);
  });
  it("revokes blocked accounts and removes pending messages on disconnect", async () => {
    await connect();
    await db.tx(sql => notify(sql, [user], "Тест", "Очередь"));
    error = new TelegramError("telegram/403");
    await deliverTelegram(db, bot);
    expect(await db.query("SELECT * FROM telegram_accounts")).toHaveLength(0);
    expect(await db.query("SELECT * FROM telegram_deliveries")).toHaveLength(0);
  });
  it("does not deliver stale reminders or data for deactivated employees", async () => {
    await connect();
    await db.tx(sql => notify(sql, [user], "Смена через 2 часа", "Отменена", "schedule", "schedule", `reminder:${uid()}:1:120`));
    await deliverTelegram(db, bot);
    expect((await db.query("SELECT last_error FROM telegram_deliveries"))[0].last_error).toBe("stale_reminder");
    await db.tx(sql => notify(sql, [user], "Тест", "Приватные данные"));
    await db.query("UPDATE users SET active=false WHERE id=$1", [user]);
    await deliverTelegram(db, bot);
    expect(sent).toHaveLength(0);
  });
});
