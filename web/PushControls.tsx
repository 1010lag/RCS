import { useEffect, useState } from "react";
import { Bell, BellOff, CheckCircle2, Send } from "lucide-react";
import { api } from "./api";
import { registerPushDevice } from "./push-client";
import { nativeApp } from "./runtime";
import { NativePushControls } from "./NativePushControls";
type Props = {
  userId: string;
  admin: boolean;
  config: any;
  offline: boolean;
  report: (text: string) => void;
};
export function PushControls(props: Props) {
  return nativeApp ? (
    <NativePushControls {...props} />
  ) : (
    <WebPushControls {...props} />
  );
}
function WebPushControls({ userId, admin, config, offline, report }: Props) {
  const [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [registered, setRegistered] = useState(false),
    [permission, setPermission] = useState(
      typeof Notification !== "undefined" ? Notification.permission : "default",
    ),
    [server, setServer] = useState<any>(null);
  const isApple =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    installed =
      matchMedia("(display-mode: standalone)").matches ||
      (navigator as any).standalone === true;
  const supported =
      typeof Notification !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window,
    secure = window.isSecureContext,
    configured = !!config?.push_ready;
  const enabled = registered && permission === "granted";
  async function status() {
    const id = localStorage.getItem("rcs-push-device");
    const state = await api(
      `/me/push-status${id ? `?device_id=${encodeURIComponent(id)}` : ""}`,
    );
    setRegistered(state.registered);
    if (admin) setServer(await api("/admin/push-status"));
  }
  useEffect(() => {
    if (!offline) void status().catch(() => {});
  }, [userId, configured, offline]);
  async function perform(fn: () => Promise<void>) {
    setWorking(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      if (e.code === "PUSH_DEVICE_EXPIRED" || e.code === "DEVICE_NOT_FOUND") {
        setRegistered(false);
        localStorage.removeItem("rcs-push-device");
        localStorage.removeItem("rcs-push-user");
      }
      setError(e.message ?? "Не удалось выполнить действие");
    } finally {
      setWorking(false);
    }
  }
  async function connect() {
    if (!secure)
      throw new Error("Откройте приложение по HTTPS, чтобы включить push");
    if (isApple && !installed)
      throw new Error(
        "На iPhone добавьте RCS на экран «Домой» и откройте его оттуда",
      );
    if (!supported)
      throw new Error("Этот браузер не поддерживает push-уведомления");
    // iOS requires permission to be requested directly from the user's click.
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result !== "granted")
      throw new Error(
        "Разрешите уведомления для RCS в настройках браузера или телефона",
      );
    await registerPushDevice(config, userId);
    setRegistered(true);
    report("Уведомления включены на этом устройстве");
  }
  async function disconnect() {
    const id = localStorage.getItem("rcs-push-device");
    if (id) await api("/me/push-devices", "DELETE", { id });
    // Remove the server association first; a token left in browser storage cannot receive this user's messages.
    localStorage.removeItem("rcs-push-device");
    localStorage.removeItem("rcs-push-user");
    setRegistered(false);
    const registration = await navigator.serviceWorker.ready;
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    report("Push на этом устройстве отключены");
  }
  async function test() {
    const id = localStorage.getItem("rcs-push-device");
    const result = await api("/me/push-test", "POST", { device_id: id });
    await status();
    if (result.accepted)
      report(
        "Тестовый push принят к отправке. Проверьте уведомления телефона.",
      );
  }
  return (
    <section className="push-controls" aria-label="Уведомления на устройстве">
      <div className="push-state">
        <span className={`tag ${registered ? "neutral" : "red"}`}>
          {registered && permission === "granted" ? (
            <>
              <CheckCircle2 size={13} />
              Включены на устройстве
            </>
          ) : (
            "Push пока не включены"
          )}
        </span>
      </div>
      {!configured && (
        <p className="muted small">
          Доставка на телефон ещё не настроена администратором. История
          уведомлений в RCS работает.
        </p>
      )}
      {!secure && (
        <p className="muted small">
          Для push на телефоне нужен HTTPS-адрес приложения.
        </p>
      )}
      {isApple && !installed && (
        <p className="muted small">
          На iPhone: откройте меню «Поделиться» → «На экран Домой», затем
          запустите RCS с появившейся иконки.
        </p>
      )}
      {permission === "denied" && (
        <p className="error">
          Уведомления запрещены. Разрешите их в настройках браузера или
          телефона, затем нажмите «Включить push».
        </p>
      )}
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div className="push-buttons">
        {!enabled ? (
          <button
            className="btn primary"
            disabled={
              !configured ||
              working ||
              offline ||
              !secure ||
              !supported ||
              (isApple && !installed)
            }
            onClick={() => perform(connect)}
          >
            <Bell size={16} />
            {working ? "Подключаем…" : "Включить push на устройстве"}
          </button>
        ) : (
          <>
            <button
              className="btn primary"
              disabled={working || offline}
              onClick={() => perform(test)}
            >
              <Send size={16} />
              Проверить push
            </button>
            <button
              className="btn"
              disabled={working || offline}
              onClick={() => perform(disconnect)}
            >
              <BellOff size={16} />
              Отключить на устройстве
            </button>
          </>
        )}
      </div>
      {registered && (
        <p className="muted small">
          Кнопка проверки отправит настоящий push только на это устройство.
          Принятие к отправке ещё не подтверждает доставку телефоном.
        </p>
      )}
      {admin && server && (
        <details className="push-admin-status">
          <summary>Состояние доставки команде</summary>
          <p>
            {server.configured
              ? "Firebase настроен"
              : "Firebase ещё не настроен"}
            {server.project_id ? ` · ${server.project_id}` : ""}
          </p>
          {server.issues?.length > 0 && (
            <p className="muted small">
              Для настройки используйте команду <code>npm run push:setup</code>.
              Подробности — в инструкции проекта.
            </p>
          )}
          <p className="muted small">
            Принято Firebase: {server.accepted ?? 0} · В очереди:{" "}
            {server.pending ?? 0} · Ошибки: {server.failed ?? 0}
          </p>
        </details>
      )}
    </section>
  );
}
