import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectPushSettings, platformPushReady } from "../server/push";

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log(
    "Настройка Firebase Cloud Messaging. Секретный JSON остаётся вне проекта; вводите только путь к нему.",
  );
  const android = process.argv.includes("--android");
  const config = android ? "" : await rl.question(
    "Firebase Web config (JSON одной строкой): ",
  );
  const vapid = android ? "" : (await rl.question("Публичный VAPID-ключ: ")).trim();
  const credentials = resolve(
    (
      await rl.question("Путь к JSON сервисного аккаунта вне репозитория: ")
    ).trim(),
  ).replaceAll("\\", "/");
  const workspace = resolve(".").replaceAll("\\", "/") + "/";
  if (credentials.toLowerCase().startsWith(workspace.toLowerCase()))
    throw new Error("Сервисный аккаунт нужно хранить вне папки репозитория");
  const origin = android ? "" : (
    await rl.question(
      "HTTPS-адрес приложения (localhost допускается только для проверки на компьютере): ",
    )
  ).trim();
  const values: Record<string, string> = {
    GOOGLE_APPLICATION_CREDENTIALS: credentials,
    ...(!android ? { FIREBASE_WEB_CONFIG: config.trim(), FIREBASE_VAPID_KEY: vapid, APP_ORIGIN: origin } : {}),
  };
  const state = await inspectPushSettings({ ...process.env, ...values });
  if (!platformPushReady(state, android ? "android" : "web")) throw new Error(state.issues.join(", "));
  if (state.projectId) values.FIREBASE_PROJECT_ID = state.projectId;
  let source = await readFile(".env", "utf8").catch(() => "");
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n']/.test(value))
      throw new Error(
        "Значения должны быть однострочными и без одинарных кавычек",
      );
    const line = `${key}='${value}'`,
      pattern = new RegExp(`^${key}=.*$`, "m");
    source = pattern.test(source)
      ? source.replace(pattern, () => line)
      : source + `\n${line}\n`;
  }
  await writeFile(".env.push-tmp", source, { mode: 0o600 });
  await rename(".env.push-tmp", ".env");
  console.log(
    android ? "Настройки Android сохранены в исключённый из Git .env. Добавьте google-services.json для by.rcs.app, пересоберите APK и перезапустите API. Затем включите уведомления в профиле." : "Конфигурация проверена и сохранена в исключённый из Git .env. Перезапустите API, откройте Профиль → Уведомления и включите push на устройстве.",
  );
} catch (e: any) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
