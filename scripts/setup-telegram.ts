import "dotenv/config";
import { telegramApi, telegramSettings } from "../server/telegram";

try {
  const originIndex = process.argv.indexOf("--origin");
  if (originIndex >= 0) process.env.APP_ORIGIN = process.argv[originIndex + 1];
  const settings = telegramSettings();
  if (!settings.ready) throw new Error("Задайте TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET (32–256 букв/цифр/_/-) и APP_ORIGIN с публичным HTTPS-адресом в окружении сервера.");
  const me = await telegramApi("getMe");
  if (me.username?.toLowerCase() !== settings.username.toLowerCase()) throw new Error("Токен и TELEGRAM_BOT_USERNAME относятся к разным ботам.");
  await telegramApi("setMyDescription", { description: "RCS — график смен команды кофейни. Расписание, биржа смен, начисления и личные уведомления в Telegram." });
  await telegramApi("setMyShortDescription", { short_description: "График смен, биржа и уведомления вашей команды." });
  await telegramApi("setMyCommands", { commands: [
    { command: "start", description: "Открыть RCS и подключить уведомления" },
    { command: "stop", description: "Отключить уведомления и вход через Telegram" },
  ] });
  await telegramApi("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть RCS", web_app: { url: settings.origin } } });
  // Configure only after the server accepts the shared webhook secret.
  const response = await fetch(`${settings.origin}/api/telegram/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": process.env.TELEGRAM_WEBHOOK_SECRET! },
    body: "{}", signal: AbortSignal.timeout(60000),
  });
  const data = await response.json().catch(() => null) as { ok?: boolean } | null;
  if (!response.ok || !data?.ok) throw new Error("Бот оформлен, кнопка RCS добавлена. Сначала обновите сервер и задайте на нём те же переменные Telegram, затем повторите telegram:setup для включения webhook.");
  await telegramApi("setWebhook", {
    url: `${settings.origin}/api/telegram/webhook`, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"], max_connections: 1, drop_pending_updates: false,
  });
  const webhook = await telegramApi("getWebhookInfo");
  console.log(`Бот @${me.username} подключён. Webhook: ${webhook.url}. Ожидают обработки: ${webhook.pending_update_count}.`);
} catch (error) {
  // Never dump request objects, fetch URLs or credentials on failure.
  console.error(error instanceof Error ? error.message : "Не удалось настроить Telegram");
  process.exitCode = 1;
}
