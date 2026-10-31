import { useEffect, useState } from "react";
import { PushNotifications } from "@capacitor/push-notifications";
import { Bell, BellOff, Send } from "lucide-react";
import { api } from "./api";
export function NativePushControls({
  userId,
  config,
  offline,
  report,
}: {
  userId: string;
  config: any;
  offline: boolean;
  report: (s: string) => void;
  admin: boolean;
}) {
  const [registered, setRegistered] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const ready =
    !!config?.push_ready &&
    import.meta.env.VITE_NATIVE_FIREBASE_CONFIGURED === "true";
  useEffect(() => {
    const id = localStorage.getItem("rcs-push-device");
    if (id && !offline)
      api(`/me/push-status?device_id=${id}`)
        .then((r) => setRegistered(r.registered))
        .catch(() => {});
  }, [userId, offline]);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message ?? "Не удалось выполнить действие");
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === "prompt")
      permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted")
      throw new Error("Разрешите уведомления для RCS в настройках Android");
    await PushNotifications.createChannel({
      id: "rcs",
      name: "Смены и события RCS",
      description: "Изменения графика, биржа и напоминания",
      importance: 4,
      visibility: 1,
    });
    const token = await new Promise<string>(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Не удалось получить подписку. Проверьте интернет"));
      }, 20000);
      let success: any, failure: any;
      function cleanup() {
        clearTimeout(timeout);
        void success?.remove();
        void failure?.remove();
      }
      success = await PushNotifications.addListener("registration", (t) => {
        cleanup();
        resolve(t.value);
      });
      failure = await PushNotifications.addListener("registrationError", () => {
        cleanup();
        reject(new Error("Не удалось подключить уведомления Android"));
      });
      await PushNotifications.register().catch((e) => {
        cleanup();
        reject(e);
      });
    });
    const device = await api("/me/push-devices", "POST", {
      token,
      platform: "android",
    });
    localStorage.setItem("rcs-push-device", device.id);
    localStorage.setItem("rcs-push-user", userId);
    setRegistered(true);
    report("Уведомления Android включены");
  }
  async function disconnect() {
    const id = localStorage.getItem("rcs-push-device");
    if (id) await api("/me/push-devices", "DELETE", { id });
    await PushNotifications.unregister();
    localStorage.removeItem("rcs-push-device");
    localStorage.removeItem("rcs-push-user");
    setRegistered(false);
    report("Уведомления на телефоне отключены");
  }
  return (
    <section className="push-controls">
      <span className={`tag ${registered ? "neutral" : "red"}`}>
        {registered
          ? "Уведомления Android включены"
          : "Уведомления Android не подключены"}
      </span>
      {!ready && (
        <p className="muted small">
          Отправка уведомлений на телефон станет доступна после настройки
          сервера и Firebase для Android.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="push-buttons">
        {registered ? (
          <>
            <button
              className="btn primary"
              disabled={busy || offline}
              onClick={() =>
                perform(async () => {
                  await api("/me/push-test", "POST", {
                    device_id: localStorage.getItem("rcs-push-device"),
                  });
                  report("Тестовый push принят к отправке");
                })
              }
            >
              <Send size={16} />
              Проверить push
            </button>
            <button
              className="btn"
              disabled={busy || offline}
              onClick={() => perform(disconnect)}
            >
              <BellOff size={16} />
              Отключить
            </button>
          </>
        ) : (
          <button
            className="btn primary"
            disabled={!ready || busy || offline}
            onClick={() => perform(connect)}
          >
            <Bell size={16} />
            Включить уведомления Android
          </button>
        )}
      </div>
    </section>
  );
}
