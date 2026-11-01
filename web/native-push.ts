import { PushNotifications } from "@capacitor/push-notifications";
import type { PluginListenerHandle } from "@capacitor/core";
import { api } from "./api";

const registrations = new Map<string, Promise<{ id: string } | null>>();
export function registerNativePushDevice(userId: string, prompt = false) {
  const existing = registrations.get(userId);
  if (existing) return existing;
  const operation = register(userId, prompt).finally(() => registrations.delete(userId));
  registrations.set(userId, operation);
  return operation;
}
async function register(userId: string, prompt: boolean) {
  let permission = await PushNotifications.checkPermissions();
  if (prompt && ["prompt", "prompt-with-rationale"].includes(permission.receive))
    permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") {
    if (!prompt) return null;
    throw new Error("Разрешите уведомления для RCS в настройках Android");
  }
  if (!prompt && localStorage.getItem("rcs-push-user") !== userId) return null;
  await PushNotifications.createChannel({ id: "rcs", name: "Смены и события RCS", description: "Изменения графика, биржа и напоминания", importance: 4, visibility: 1 });
  const handles: PluginListenerHandle[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveToken!: (value: string) => void, rejectToken!: (error: Error) => void;
  const tokenEvent = new Promise<string>((resolve, reject) => { resolveToken = resolve; rejectToken = reject; });
  // Attach the rejection handler before installing listeners: retained native
  // events can be delivered immediately, before register() is called.
  const result = tokenEvent.then((token) => ({ token }), (error: Error) => ({ error }));
  try {
    handles.push(await PushNotifications.addListener("registration", (event) => resolveToken(event.value)));
    handles.push(await PushNotifications.addListener("registrationError", () => rejectToken(new Error("Не удалось подключить уведомления Android"))));
    timer = setTimeout(() => rejectToken(new Error("Не удалось получить подписку. Проверьте интернет")), 20000);
    await PushNotifications.register();
    const received = await result;
    if ("error" in received) throw received.error;
    if (!prompt && localStorage.getItem("rcs-push-user") !== userId) return null;
    const device = await api<{ id: string }>("/me/push-devices", "POST", { token: received.token, platform: "android", user_id: userId });
    if (!prompt && localStorage.getItem("rcs-push-user") !== userId) {
      await api("/me/push-devices", "DELETE", { id: device.id });
      return null;
    }
    localStorage.setItem("rcs-push-device", device.id);
    localStorage.setItem("rcs-push-user", userId);
    return device;
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.allSettled(handles.map((handle) => handle.remove()));
  }
}
