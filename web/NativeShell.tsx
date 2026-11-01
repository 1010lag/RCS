import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, RefreshCw, Server, Settings } from "lucide-react";
import {
  checkServer,
  serverBase,
  validateServer,
} from "./runtime";
import { prepareNativeServer, switchNativeServer } from "./native-server";
export function NativeShell({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"checking" | "choose" | "ready">(
      "checking",
    ),
    [address, setAddress] = useState(serverBase()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    prepareNativeServer()
      .then((url) => {
        if (live) setAddress(url);
        return checkServer(url);
      })
      .then(() => {
        if (live) setPhase("ready");
      })
      .catch(() => {
        if (live) {
          setPhase("choose");
          setError(
            "Сервер недоступен. Проверьте интернет и адрес сервера. После простоя запуск может занять около минуты.",
          );
        }
      });
    const change = () => {
      setAddress(serverBase());
      setPhase("choose");
      setError("");
    };
    window.addEventListener("rcs-change-server", change);
    return () => {
      live = false;
      window.removeEventListener("rcs-change-server", change);
    };
  }, []);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const url = validateServer(address);
      await checkServer(url);
      await switchNativeServer(url);
      setPhase("ready");
    } catch (e: any) {
      setError(
        "Не удалось подключиться к RCS. Проверьте интернет и адрес сервера; при первом запуске после простоя попробуйте ещё раз через минуту.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (phase === "ready") return <>{children}</>;
  return (
    <div className="native-connect">
      <span className="brand">
        RCS<span>.</span>
      </span>
      <span className="native-connect-icon">
        <Server size={31} />
      </span>
      <h1>
        {phase === "checking"
          ? "Подключаемся к команде"
          : "Сервер вашей кофейни"}
      </h1>
      <p>Ваш график, ставки и смены хранятся на общем сервере команды.</p>
      {phase === "checking" ? (
        <span className="spinner" />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <label className="field">
            <span>Адрес сервера RCS</span>
            <input
              aria-label="Адрес сервера RCS"
              type="url"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
              placeholder="https://rcs.example.com"
            />
          </label>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <button className="btn primary full" disabled={busy}>
            {busy ? "Проверяем…" : "Подключиться"}
            <ArrowRight size={18} />
          </button>
          <button
            className="btn full"
            type="button"
            disabled={busy}
            onClick={() => setPhase("ready")}
          >
            Открыть сохранённые данные
          </button>
          <small>
            Публичный сервер работает через Wi-Fi и мобильный интернет.
          </small>
        </form>
      )}
    </div>
  );
}
