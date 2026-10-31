import { readFile } from "node:fs/promises";
import { createPrivateKey, ECDH } from "node:crypto";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { z } from "zod";

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
export async function inspectPushSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PushSettings> {
  const issues: string[] = [];
  if (!env.FIREBASE_WEB_CONFIG) issues.push("FIREBASE_WEB_CONFIG");
  if (!env.FIREBASE_VAPID_KEY) issues.push("FIREBASE_VAPID_KEY");
  if (!env.GOOGLE_APPLICATION_CREDENTIALS && env.FIREBASE_USE_ADC !== "1")
    issues.push("GOOGLE_APPLICATION_CREDENTIALS");
  if (!env.APP_ORIGIN) issues.push("APP_ORIGIN");
  const state: PushSettings = {
    ready: false,
    status: issues.length === 4 ? "unconfigured" : "incomplete",
    issues,
    config: null,
    vapidKey: null,
    origin: null,
  };
  if (issues.length) return state;
  try {
    state.config = webConfigSchema.parse(JSON.parse(env.FIREBASE_WEB_CONFIG!));
    const vapid = Buffer.from(env.FIREBASE_VAPID_KEY!, "base64url");
    if (vapid.length !== 65 || vapid[0] !== 4) throw new Error("VAPID");
    ECDH.convertKey(vapid, "prime256v1");
    const origin = new URL(env.APP_ORIGIN!);
    if (
      (origin.protocol !== "https:" &&
        !(
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) &&
          origin.protocol === "http:"
        )) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("ORIGIN");
    if (env.GOOGLE_APPLICATION_CREDENTIALS) {
      const credential = JSON.parse(
        await readFile(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"),
      );
      if (
        credential.type !== "service_account" ||
        credential.project_id !== state.config.projectId ||
        typeof credential.client_email !== "string"
      )
        throw new Error("CREDENTIAL");
      createPrivateKey(credential.private_key);
    }
    return {
      ...state,
      ready: true,
      status: "ready",
      vapidKey: env.FIREBASE_VAPID_KEY!,
      origin: origin.origin,
    };
  } catch {
    return {
      ...state,
      config: null,
      issues: [
        "Проверьте Web-конфигурацию, публичный VAPID-ключ, адрес приложения и серверные credentials одного Firebase-проекта",
      ],
      status: "invalid",
    };
  }
}
let cachedKey = "",
  cached: Promise<PushSettings> | null = null;
export const firebasePush: PushGateway = {
  settings() {
    const key = JSON.stringify([
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
    const settings = await this.settings();
    if (!settings.ready)
      throw Object.assign(new Error("Push не настроен"), {
        code: "push/not-configured",
      });
    const app =
      getApps().find((a) => a.name === "rcs-push") ??
      initializeApp(
        {
          credential: applicationDefault(),
          projectId: settings.config!.projectId,
        },
        "rcs-push",
      );
    if (message.platform === "android")
      return getMessaging(app).send({
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: { link: safePushLink(message.link), notification_id: message.id },
        android: {
          priority: "high",
          notification: {
            channelId: "rcs",
            icon: "ic_stat_rcs",
            color: "#E10600",
          },
        },
      });
    // A data-only payload is displayed exactly once by our own service worker.
    return getMessaging(app).send({
      token: message.token,
      data: {
        title: message.title,
        body: message.body,
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
