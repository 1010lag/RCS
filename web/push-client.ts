import { api } from "./api";
import { nativeApp } from "./runtime";
export async function clearPushRegistration(config: any) {
  localStorage.removeItem("rcs-push-device");
  localStorage.removeItem("rcs-push-user");
  try {
    if (nativeApp && import.meta.env.VITE_NATIVE_FIREBASE_CONFIGURED === "true") {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      await PushNotifications.unregister();
    } else if (!nativeApp && config?.push_config?.projectId) {
      const [{ getApps }, { getMessaging, deleteToken }] = await Promise.all([import("@firebase/app"), import("@firebase/messaging")]);
      const firebase = getApps().find((app) => app.name === `rcs-web-push-${config.push_config.projectId}`);
      if (firebase) await deleteToken(getMessaging(firebase));
    }
  } catch { /* The server also revokes every device bound to the expired session. */ }
}
export async function registerPushDevice(config: any, userId: string) {
  if (!config?.push_ready || Notification.permission !== "granted") return null;
  const [{ getApps, initializeApp }, { getMessaging, getToken, isSupported }] =
    await Promise.all([import("@firebase/app"), import("@firebase/messaging")]);
  if (!(await isSupported()))
    throw new Error("Этот браузер не поддерживает push-уведомления");
  const name = `rcs-web-push-${config.push_config.projectId}`;
  const firebase =
    getApps().find((app) => app.name === name) ??
    initializeApp(config.push_config, name);
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(firebase), {
    vapidKey: config.vapid_key,
    serviceWorkerRegistration: registration,
  });
  if (!token)
    throw new Error("Браузер не вернул push-подписку. Попробуйте ещё раз");
  const device = await api("/me/push-devices", "POST", { token });
  localStorage.setItem("rcs-push-device", device.id);
  localStorage.setItem("rcs-push-user", userId);
  return device;
}
