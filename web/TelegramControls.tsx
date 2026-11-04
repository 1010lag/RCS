import { useEffect, useState } from "react";
import { CheckCircle2, Send, Unlink } from "lucide-react";
import { api } from "./api";
import { openTelegram } from "./telegram";

type Status = { configured: boolean; connected: boolean; bot_url: string | null };
export function TelegramControls({ userId, offline, report }: { userId: string; offline: boolean; report: (text: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null), [busy, setBusy] = useState(false),
    [error, setError] = useState(""), [link, setLink] = useState("");
  async function refresh() {
    const result = await api<Status>("/me/telegram");
    setStatus(result);
    if (result.connected) setLink("");
  }
  useEffect(() => {
    if (offline) return;
    let live = true;
    const update = () => { void api<Status>("/me/telegram").then(result => { if (live) { setStatus(result); if (result.connected) setLink(""); } }).catch(() => {}); };
    update();
    window.addEventListener("focus", update);
    const timer = link ? setInterval(update, 5000) : undefined;
    return () => { live = false; window.removeEventListener("focus", update); clearInterval(timer); };
  }, [userId, offline, link]);
  async function perform(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (e: any) { setError(e.message ?? "Не удалось подключить Telegram"); }
    finally { setBusy(false); }
  }
  return <section className="push-controls" aria-label="Уведомления в Telegram">
    <h3>Telegram</h3>
    <p className="muted small">Открывайте RCS прямо в Telegram. Бот присылает уведомления о сменах, бирже и начислениях — по настройкам выше.</p>
    <div className="push-state"><span className={`tag ${status?.connected ? "neutral" : "red"}`}>
      {status?.connected ? <><CheckCircle2 size={13} />Telegram подключён</> : "Telegram пока не подключён"}
    </span></div>
    {status && !status.configured && <p className="muted small">Бот ещё не подключён к серверу. После настройки здесь появится кнопка подключения.</p>}
    {error && <div className="error" role="alert">{error}</div>}
    <div className="push-buttons">
      {!status?.connected ? <button className="btn primary" disabled={!status?.configured || busy || offline} onClick={() => void perform(async () => {
        const result = await api<{ url: string }>("/me/telegram/link", "POST");
        setLink(result.url);
      })}><Send size={16} />{busy ? "Готовим ссылку…" : "Подключить Telegram"}</button> : <>
        <button className="btn primary" disabled={!status.configured || busy || offline} onClick={() => void perform(async () => {
          await api("/me/telegram/test", "POST"); report("Проверочное уведомление добавлено в очередь Telegram");
        })}><Send size={16} />Проверить Telegram</button>
        <button className="btn" disabled={busy || offline} onClick={() => void perform(async () => {
          await api("/me/telegram", "DELETE"); await refresh(); report("Telegram отключён");
        })}><Unlink size={16} />Отключить Telegram</button>
      </>}
    </div>
    {link && <div className="telegram-connect">
      <p className="muted small">Откройте бота и нажмите «Запустить». Ссылка действует 10 минут.</p>
      <button className="btn primary" onClick={() => openTelegram(link)}><Send size={16} />Открыть бота и подключить</button>
      <button className="btn" disabled={busy || offline} onClick={() => void perform(refresh)}>Проверить подключение</button>
    </div>}
  </section>;
}
