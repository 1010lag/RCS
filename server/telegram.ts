import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database, Sql } from "./db";
import { fail } from "./domain";
import { notificationText } from "./notification-text";
import { safePushLink } from "./push";

export const telegramDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export function telegramSettings(env: NodeJS.ProcessEnv = process.env) {
  const username = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") ?? "";
  let origin: string | null = null;
  try {
    const url = new URL(env.APP_ORIGIN ?? "");
    if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) origin = url.origin;
  } catch { /* Public HTTPS is required for Telegram Mini Apps. */ }
  const ready = Boolean(/^\d+:[\w-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN ?? "") && /^[a-zA-Z0-9_]{5,32}$/.test(username) && /^[\w-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET ?? "") && origin);
  return { ready, username, origin, botUrl: username ? `https://t.me/${username}` : null };
}
export interface TelegramGateway {
  ready(): boolean;
  send(chatId: string, title: string, body: string, link: string): Promise<void>;
}
export class TelegramError extends Error {
  constructor(public code: string, public retryAfter = 0) { super(code); }
}
export async function telegramApi<T = any>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramError("telegram/unconfigured");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
  } catch { throw new TelegramError("telegram/network"); }
  let data: any;
  try { data = await response.json(); }
  catch { throw new TelegramError("telegram/response"); }
  if (!response.ok || !data.ok) throw new TelegramError(`telegram/${data.error_code ?? response.status}`, Number(data.parameters?.retry_after) || 0);
  return data.result as T;
}
export const telegramBot: TelegramGateway = {
  ready: () => telegramSettings().ready,
  async send(chatId, title, body, link) {
    const settings = telegramSettings();
    if (!settings.ready) throw new TelegramError("telegram/unconfigured");
    await telegramApi("sendMessage", {
      chat_id: chatId, text: `${title}\n\n${notificationText(body)}`.slice(0, 4096),
      reply_markup: { inline_keyboard: [[{ text: "Открыть RCS", web_app: { url: `${settings.origin}/?tg_target=${encodeURIComponent(safePushLink(link))}` } }]] },
    });
  },
};
export function validWebhookSecret(value: unknown) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  return Boolean(secret && typeof value === "string" && timingSafeEqual(Buffer.from(telegramDigest(value)), Buffer.from(telegramDigest(secret))));
}
export function validateTelegramData(raw: string, at = Date.now()) {
  const params = new URLSearchParams(raw), hash = params.get("hash") ?? "";
  if (!process.env.TELEGRAM_BOT_TOKEN || !/^[a-f0-9]{64}$/.test(hash) || new Set(params.keys()).size !== [...params.keys()].length)
    fail("TELEGRAM_AUTH", "Не удалось проверить Telegram. Откройте приложение из бота заново", 401);
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(process.env.TELEGRAM_BOT_TOKEN!).digest();
  const expected = createHmac("sha256", key).update(check).digest();
  const age = at / 1000 - Number(params.get("auth_date"));
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex")) || !Number.isFinite(age) || age < -30 || age > 600)
    fail("TELEGRAM_AUTH", "Сессия Telegram устарела. Откройте приложение из бота заново", 401);
  let user: any;
  try { user = JSON.parse(params.get("user") ?? "null"); } catch { /* Reject below. */ }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot)
    fail("TELEGRAM_AUTH", "Не удалось проверить пользователя Telegram", 401);
  return String(user.id);
}
export async function clearTelegram(sql: Sql, userId: string) {
  await sql.query("DELETE FROM telegram_links WHERE user_id=$1", [userId]);
  await sql.query("DELETE FROM telegram_accounts WHERE user_id=$1", [userId]);
}
export async function createTelegramLink(db: Database, userId: string) {
  const settings = telegramSettings();
  if (!settings.ready) fail("TELEGRAM_UNCONFIGURED", "Бот Telegram ещё не подключён к серверу", 503);
  const token = randomBytes(24).toString("base64url");
  await db.tx(async sql => {
    await sql.query("DELETE FROM telegram_links WHERE user_id=$1 OR expires_at<=clock_timestamp()", [userId]);
    await sql.query("INSERT INTO telegram_links(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes')", [telegramDigest(token), userId]);
  });
  return { url: `${settings.botUrl}?start=link_${token}`, expires_in: 600 };
}
export async function handleTelegramUpdate(db: Database, update: any, bot: TelegramGateway = telegramBot) {
  const message = update?.message;
  if (!Number.isSafeInteger(update?.update_id) || !message || message.chat?.type !== "private" || message.from?.is_bot || !Number.isSafeInteger(message.from?.id) || message.from.id !== message.chat.id) return;
  const chat = String(message.chat.id), text = String(message.text ?? "");
  const result = await db.tx(async sql => {
    const fresh = await sql.query("INSERT INTO telegram_updates(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id", [String(update.update_id)]);
    if (!fresh.length) return null;
    if (/^\/stop(?:@\w+)?\s*$/.test(text)) {
      await sql.query("DELETE FROM telegram_accounts WHERE chat_id=$1", [chat]);
      return { title: "Уведомления Telegram отключены", body: "Подключить их снова можно в профиле RCS." };
    }
    const match = /^\/start(?:@\w+)?(?:\s+link_([\w-]{32}))?\s*$/.exec(text);
    if (!match) return null;
    if (!match[1]) return { title: "RCS — команда в ритме", body: "Откройте приложение. Для уведомлений войдите в свой профиль → Telegram → Подключить Telegram." };
    const link = (await sql.query("SELECT l.user_id FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE l.token_hash=$1 AND l.expires_at>clock_timestamp() AND u.active AND NOT u.must_change_password FOR UPDATE OF l", [telegramDigest(match[1])]))[0];
    if (!link) return { title: "Ссылка недействительна", body: "Создайте новую ссылку в профиле RCS. Ссылка действует 10 минут и используется один раз." };
    const existing = (await sql.query("SELECT user_id FROM telegram_accounts WHERE chat_id=$1", [chat]))[0];
    if (existing && existing.user_id !== link.user_id) return { title: "Этот Telegram уже подключён", body: "Сначала отключите Telegram в прежнем профиле RCS или отправьте /stop." };
    await clearTelegram(sql, link.user_id);
    await sql.query("INSERT INTO telegram_accounts(user_id,chat_id) VALUES($1,$2)", [link.user_id, chat]);
    return { title: "Telegram подключён к RCS", body: "Сюда будут приходить ваши уведомления о сменах, бирже и начислениях. Настройки — в профиле. Отключение: /stop." };
  });
  if (result) {
    // A committed update must not be replayed if Telegram times out on the reply.
    try { await bot.send(chat, result.title, result.body, "profile"); } catch { /* Notifications use the durable delivery queue. */ }
  }
}
export async function deliverTelegram(db: Database, bot: TelegramGateway = telegramBot) {
  if (!bot.ready()) return;
  const deliveries = await db.query(`SELECT d.id,d.attempts,a.chat_id,n.title,n.body,n.link,n.dedup_key,n.user_id
    FROM telegram_deliveries d JOIN telegram_accounts a ON a.id=d.account_id
    JOIN notifications n ON n.id=d.notification_id AND n.user_id=a.user_id
    JOIN users u ON u.id=a.user_id AND u.active AND NOT u.must_change_password
    LEFT JOIN preferences p ON p.user_id=u.id
    WHERE d.sent_at IS NULL AND d.attempts<8 AND d.next_attempt<=clock_timestamp()
      AND COALESCE((to_jsonb(p)->>n.category)::boolean,true)
    ORDER BY d.next_attempt LIMIT 20`);
  for (const d of deliveries) {
    const current = await db.query("SELECT 1 FROM telegram_deliveries d JOIN telegram_accounts a ON a.id=d.account_id JOIN users u ON u.id=a.user_id WHERE d.id=$1 AND a.chat_id=$2 AND u.active AND NOT u.must_change_password", [d.id, d.chat_id]);
    if (!current.length) continue;
    if (d.dedup_key?.startsWith("reminder:")) {
      const [, id, version, interval] = d.dedup_key.split(":");
      const valid = await db.query("SELECT 1 FROM shifts s LEFT JOIN preferences p ON p.user_id=s.user_id WHERE s.id=$1 AND s.version=$2 AND s.user_id=$3 AND s.status IN ('planned','confirmed') AND s.start_at>clock_timestamp() AND COALESCE((to_jsonb(p)->>$4)::boolean,$5)", [id, Number(version), d.user_id, `reminder_${interval}`, interval === "120"]);
      if (!valid.length) { await db.query("UPDATE telegram_deliveries SET attempts=8,last_error='stale_reminder' WHERE id=$1", [d.id]); continue; }
    }
    try {
      await bot.send(d.chat_id, d.title, d.body, d.link);
      await db.query("UPDATE telegram_deliveries SET sent_at=clock_timestamp(),attempts=attempts+1,last_error=NULL WHERE id=$1", [d.id]);
    } catch (error) {
      const e = error instanceof TelegramError ? error : new TelegramError("telegram/delivery");
      if (e.code === "telegram/403") await db.query("DELETE FROM telegram_accounts WHERE chat_id=$1", [d.chat_id]);
      else await db.query("UPDATE telegram_deliveries SET attempts=attempts+1,last_error=$2,next_attempt=clock_timestamp()+($3::text||' seconds')::interval WHERE id=$1", [d.id, e.code, Math.max(e.retryAfter, Math.min(3600, 2 ** (d.attempts + 1) * 15))]);
      if (e.code === "telegram/429") break;
    }
  }
}
