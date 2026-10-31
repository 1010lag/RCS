import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectPushSettings } from "../server/push";

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log(
    "Настройка Firebase Cloud Messaging. Секретный JSON остаётся вне проекта; вводите только путь к нему.",
  );
  const config = await rl.question(
    "Firebase Web config (JSON одной строкой): ",
  );
  const vapid = (await rl.question("Публичный VAPID-ключ: ")).trim();
  const credentials = resolve(
    (
      await rl.question("Путь к JSON сервисного аккаунта вне репозитория: ")
    ).trim(),
  ).replaceAll("\\", "/");
  const workspace = resolve(".").replaceAll("\\", "/") + "/";
  if (credentials.toLowerCase().startsWith(workspace.toLowerCase()))
    throw new Error("Сервисный аккаунт нужно хранить вне папки репозитория");
  const origin = (
    await rl.question(
      "HTTPS-адрес приложения (localhost допускается только для проверки на компьютере): ",
    )
  ).trim();
  const values = {
    FIREBASE_WEB_CONFIG: config.trim(),
    FIREBASE_VAPID_KEY: vapid,
    GOOGLE_APPLICATION_CREDENTIALS: credentials,
    APP_ORIGIN: origin,
  };
  const state = await inspectPushSettings({ ...process.env, ...values });
  if (!state.ready) throw new Error(state.issues.join(", "));
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
    "Конфигурация проверена и сохранена в исключённый из Git .env. Перезапустите API, откройте Профиль → Уведомления и включите push на устройстве.",
  );
} catch (e: any) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
