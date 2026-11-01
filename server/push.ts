import { readFile } from "node:fs/promises";
import { createPrivateKey, ECDH } from "node:crypto";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { z } from "zod";
import { notificationText } from "./notification-text";

const webConfigSchema = z.object({
  apiKey: z.string().min(10),
  appId: z.string().min(5),
  projectId: z.string().min(3),
  messagingSenderId: z.string().regex(/^\d+$/),
  authDomain: z.string().optional(),
  storageBucket: z.string().optional(),
  measurementId: z.string().optional(),
});
export type PushSettings = {
  ready: boolean;
  androidReady?: boolean;
  webReady?: boolean;
  projectId?: string | null;
  status: "unconfigured" | "incomplete" | "invalid" | "ready";
  issues: string[];
  config: z.infer<typeof webConfigSchema> | null;
  vapidKey: string | null;
  origin: string | null;
};
export type PushMessage = {
  platform?: "web" | "android";
  token: string;
  title: string;
  body: string;
  link: string;
  id: string;
};
export interface PushGateway {
  settings(): Promise<PushSettings>;
  send(message: PushMessage): Promise<string>;
}
export function platformPushReady(settings: PushSettings, platform: "web" | "android" = "web") {
  return platform === "android" ? settings.androidReady ?? settings.ready : settings.webReady ?? settings.ready;
}
export async function inspectPushSettings(env: NodeJS.ProcessEnv = process.env): Promise<PushSettings> {
  const issues: string[] = [];
  let projectId = env.FIREBASE_PROJECT_ID?.trim() || null;
  let config: PushSettings["config"] = null;
  let invalid = false;
  if (env.FIREBASE_WEB_CONFIG) {
    try { config = webConfigSchema.parse(JSON.parse(env.FIREBASE_WEB_CONFIG)); }
    catch { invalid = true; issues.push("Неверная Web-конфигурация Firebase"); }
  } else issues.push("FIREBASE_WEB_CONFIG");

  let credentialsValid = false;
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const credential = JSON.parse(await readFile(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
      if (credential.type !== "service_account" || typeof credential.project_id !== "string" || credential.project_id.length < 3 || typeof credential.client_email !== "string") throw new Error("CREDENTIAL");
      if (projectId && projectId !== credential.project_id) throw new Error("PROJECT");
      createPrivateKey(credential.private_key);
      projectId = credential.project_id;
      credentialsValid = true;
    } catch { invalid = true; issues.push("Серверные credentials Firebase недействительны или относятся к другому проекту"); }
  } else if (env.FIREBASE_USE_ADC === "1") {
    projectId ??= config?.projectId ?? null;
    credentialsValid = Boolean(projectId);
    if (!projectId) issues.push("FIREBASE_PROJECT_ID");
  } else issues.push("GOOGLE_APPLICATION_CREDENTIALS");

  let vapidKey: string | null = null;
  if (env.FIREBASE_VAPID_KEY) {
    try {
      const vapid = Buffer.from(env.FIREBASE_VAPID_KEY, "base64url");
      if (vapid.length !== 65 || vapid[0] !== 4) throw new Error("VAPID");
      ECDH.convertKey(vapid, "prime256v1");
      vapidKey = env.FIREBASE_VAPID_KEY;
    } catch { invalid = true; issues.push("Неверный публичный VAPID-ключ"); }
  } else issues.push("FIREBASE_VAPID_KEY");

  let origin: string | null = null;
  if (env.APP_ORIGIN) {
    try {
      const url = new URL(env.APP_ORIGIN);
      if ((url.protocol !== "https:" && !(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("ORIGIN");
      origin = url.origin;
    } catch { invalid = true; issues.push("Web Push требует HTTPS-адрес приложения"); }
  } else issues.push("APP_ORIGIN");

  const androidReady = credentialsValid && Boolean(projectId);
  const webProjectMatches = Boolean(config && config.projectId === projectId);
  if (config && projectId && !webProjectMatches) { invalid = true; issues.push("Web-приложение и серверный аккаунт относятся к разным Firebase-проектам"); }
  const webReady = androidReady && webProjectMatches && Boolean(vapidKey && origin);
  const ready = androidReady || webReady;
  const empty = !env.FIREBASE_PROJECT_ID && !env.FIREBASE_WEB_CONFIG && !env.FIREBASE_VAPID_KEY && !env.GOOGLE_APPLICATION_CREDENTIALS && env.FIREBASE_USE_ADC !== "1" && !env.APP_ORIGIN;
  return {
    ready, androidReady, webReady, projectId,
    status: ready ? "ready" : invalid ? "invalid" : empty ? "unconfigured" : "incomplete",
    issues, config: webReady ? config : null,
    vapidKey: webReady ? vapidKey : null, origin,
  };
}
let cachedKey = "",
  cached: Promise<PushSettings> | null = null;
export const firebasePush: PushGateway = {
  settings() {
    const key = JSON.stringify([
      process.env.FIREBASE_PROJECT_ID,
      process.env.FIREBASE_WEB_CONFIG,
      process.env.FIREBASE_VAPID_KEY,
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      process.env.FIREBASE_USE_ADC,
      process.env.APP_ORIGIN,
    ]);
    if (!cached || key !== cachedKey) {
      cachedKey = key;
      cached = inspectPushSettings();
    }
    return cached;
  },
  async send(message) {
    const body = notificationText(message.body);
    const settings = await this.settings();
    if (!platformPushReady(settings, message.platform))
      throw Object.assign(new Error("Push не настроен"), {
        code: "push/not-configured",
      });
    const app =
      getApps().find((a) => a.name === "rcs-push") ??
      initializeApp(
        {
          credential: applicationDefault(),
          projectId: settings.projectId ?? settings.config?.projectId,
        },
        "rcs-push",
      );
    if (message.platform === "android")
      return getMessaging(app).send({
        token: message.token,
        notification: { title: message.title, body },
        data: { link: safePushLink(message.link), notification_id: message.id },
        android: {
          priority: "high",
          ttl: 3600000,
          notification: {
            channelId: "rcs",
            icon: "ic_stat_rcs",
            color: "#E10600",
            tag: message.id,
            defaultSound: true,
          },
        },
      });
    // A data-only payload is displayed exactly once by our own service worker.
    return getMessaging(app).send({
      token: message.token,
      data: {
        title: message.title,
        body,
        link: safePushLink(message.link),
        notification_id: message.id,
      },
      webpush: { headers: { TTL: "3600", Urgency: "normal" } },
    });
  },
};
export function safePushLink(link: string) {
  return /^(shift:[a-f0-9-]+|home|schedule|exchange|payroll|notifications|profile|employees|types|audit)$/.test(
    link,
  )
    ? link
    : "notifications";
}
export function invalidPushToken(error: any) {
  return [
    "messaging/registration-token-not-registered",
    "messaging/invalid-registration-token",
  ].includes(error?.code);
}
