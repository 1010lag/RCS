import { useEffect, useState } from "react";
import { CheckCircle2, Download } from "lucide-react";
import { telegramApp, type TelegramHomeScreenStatus } from "./telegram";

export function TelegramHomeScreen({ compact = false }: { compact?: boolean }) {
  const app = telegramApp();
  const supported = Boolean(app?.isVersionAtLeast?.("8.0") && app.addToHomeScreen && app.checkHomeScreenStatus);
  const [status, setStatus] = useState<TelegramHomeScreenStatus>(supported ? "unknown" : "unsupported");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!app || !supported) return;
    let live = true;
    const added = () => {
      if (!live) return;
      setStatus("added");
      setMessage("");
    };
    const check = () => {
      try {
        app.checkHomeScreenStatus!(value => {
          if (!live) return;
          setStatus(value);
          if (value === "added") setMessage("");
        });
      } catch {
        if (live) setStatus("unsupported");
      }
    };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    app.onEvent?.("homeScreenAdded", added);
    app.onEvent?.("activated", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", visible);
    check();
    return () => {
      live = false;
      app.offEvent?.("homeScreenAdded", added);
      app.offEvent?.("activated", check);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [app, supported]);

  if (!app || (compact && status === "unsupported")) return null;
  const installed = status === "added";
  const button = <button
    className={compact ? "nav-item" : "btn primary"}
    disabled={!supported || status === "unsupported" || installed}
    onClick={() => {
      try {
        // Call directly from the click so Telegram can open its native prompt.
        setMessage("Подтвердите добавление ярлыка в окне Telegram. Если окно не появилось, проверьте разрешение Telegram на создание ярлыков в настройках телефона.");
        app.addToHomeScreen!();
      } catch {
        setMessage("Не удалось открыть добавление ярлыка. Обновите Telegram и попробуйте ещё раз.");
      }
    }}
  >
    {installed ? <CheckCircle2 size={compact ? 19 : 16} /> : <Download size={compact ? 19 : 16} />}
    {installed ? "Ярлык добавлен" : "На главный экран"}
  </button>;

  if (compact) return <div>{button}{message && <p className="muted small" role="status">{message}</p>}</div>;
  return <section className="push-controls" aria-label="Ярлык RCS">
    <h3>Ярлык на рабочем столе</h3>
    <p className="muted small">Открывайте RCS с главного экрана телефона — сразу в Telegram.</p>
    {status === "unsupported" ? <p className="muted small">Добавление ярлыка недоступно в этой версии Telegram или на этом устройстве. Попробуйте обновить Telegram на телефоне.</p> : <div className="push-buttons">{button}</div>}
    {message && <p className="muted small" role="status">{message}</p>}
  </section>;
}
