import { useEffect, useState } from "react";
import { PushNotifications } from "@capacitor/push-notifications";
import { Bell, BellOff, Send } from "lucide-react";
import { api } from "./api";
import { registerNativePushDevice } from "./native-push";
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
  const built = import.meta.env.VITE_NATIVE_FIREBASE_CONFIGURED === "true";
  const wrongProject = !!import.meta.env.VITE_NATIVE_FIREBASE_PROJECT_ID && !!config?.push_project_id && import.meta.env.VITE_NATIVE_FIREBASE_PROJECT_ID !== config.push_project_id;
  const ready = !!(config?.push_android_ready ?? config?.push_ready) && built && !wrongProject;
  useEffect(() => {
    const id = localStorage.getItem("rcs-push-device");
    if (id && !offline)
      api(`/me/push-status?platform=android&device_id=${id}`)
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
    await registerNativePushDevice(userId, true);
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
          {wrongProject ? "Приложение и сервер подключены к разным проектам уведомлений. Установите актуальную версию RCS." : !built ? "Для подключения уведомлений установите обновление RCS с настроенным Firebase." : "Доставка уведомлений ещё не подключена на сервере."}
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
