import {
  useEffect,
  useId,
  useRef,
  useState,
  cloneElement,
  isValidElement,
  type ReactElement,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Plus,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  LayoutDashboard,
  Users,
  Layers,
  ArrowLeftRight,
  Wallet,
  Bell,
  History,
  Settings,
  LogOut,
  Coffee,
  Clock,
  Check,
  CheckCheck,
  X,
  Search,
  WifiOff,
  RefreshCw,
  SlidersHorizontal,
  LockKeyhole,
  Download,
  Menu,
  Send,
  ShieldCheck,
  Ellipsis,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import type {
  User,
  Shift,
  ShiftType,
  Listing,
  Notice,
  PayrollRow,
  Audit,
} from "../shared/types";
import { statusLabels } from "../shared/types";
import {
  api,
  ApiError,
  setCsrf,
  cacheRead,
  cacheWrite,
  cacheClear,
} from "./api";
import {
  minskDate,
  addDays,
  weekStart,
  monthStart,
  monthGridRange,
  monthEnd,
  moveMonth,
  label,
  currency,
  hours,
  stamp,
  initials,
  plural,
} from "./dates";
import { Schedule } from "./Schedule";
import { CoffeeArt } from "./CoffeeArt";
import { ThemeSettings } from "./ThemeSettings";
import { AvatarSettings } from "./AvatarSettings";
import { BatchShiftForm } from "./BatchShiftForm";
import { canTakeExchangeAt } from "../shared/exchange-window";
import { PushControls } from "./PushControls";
import { registerPushDevice, clearPushRegistration } from "./push-client";
import { nativeApp, serverBase } from "./runtime";
type View =
  | "home"
  | "schedule"
  | "exchange"
  | "employees"
  | "types"
  | "payroll"
  | "notifications"
  | "audit"
  | "profile";
type Snapshot = {
  shifts: Shift[];
  mine: Shift[];
  team: { id: string; name: string; avatar_url?: string | null }[];
  types: ShiftType[];
  listings: Listing[];
  notices: Notice[];
  payroll: PayrollRow[];
  synced: string;
};
type Modal =
  | { kind: "shift"; shift?: Shift; date?: string; userId?: string }
  | { kind: "employee"; employee?: User }
  | { kind: "account" }
  | { kind: "name" }
  | { kind: "adjustmentCredit"; adjustment: { id: string; user_name: string } }
  | { kind: "rate"; employee: User }
  | { kind: "deleteEmployee"; employee: User }
  | { kind: "deleteType"; type: ShiftType }
  | { kind: "type"; type?: ShiftType }
  | { kind: "take"; listing: Listing; quote: any; key: string }
  | { kind: "reason"; title: string; action: (reason: string) => Promise<any> }
  | { kind: "adjust"; shift: Shift }
  | { kind: "message" }
  | { kind: "publish"; shift: Shift }
  | { kind: "detail"; shift: Shift };
const titles: Record<View, string> = {
  home: "Обзор",
  schedule: "График смен",
  exchange: "Биржа смен",
  employees: "Команда",
  types: "Типы смен",
  payroll: "Часы и начисления",
  notifications: "Уведомления",
  audit: "Журнал действий",
  profile: "Профиль",
};
const navItems: [View, string, any][] = [
  ["home", "Обзор", LayoutDashboard],
  ["schedule", "График смен", CalendarDays],
  ["exchange", "Биржа смен", ArrowLeftRight],
  ["employees", "Команда", Users],
  ["types", "Типы смен", Layers],
  ["payroll", "Расчёты", Wallet],
  ["notifications", "Уведомления", Bell],
  ["audit", "Журнал действий", History],
];
const empty: Snapshot = {
  shifts: [],
  mine: [],
  team: [],
  types: [],
  listings: [],
  notices: [],
  payroll: [],
  synced: "",
};
export function App() {
  const [user, setUser] = useState<User | null>(null),
    [boot, setBoot] = useState(true),
    [view, setView] = useState<View>("home"),
    [data, setData] = useState<Snapshot>(empty),
    [anchor, setAnchor] = useState(minskDate()),
    [now, setNow] = useState(new Date()),
    [offline, setOffline] = useState(!navigator.onLine),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [modal, updateModal] = useState<Modal | null>(null),
    [busy, setBusy] = useState(false),
    [employees, setEmployees] = useState<User[]>([]),
    [employeeArchive, setEmployeeArchive] = useState(false),
    [typeArchive, setTypeArchive] = useState(false),
    [auditRows, setAuditRows] = useState<Audit[]>([]),
    [history, setHistory] = useState<Listing[]>([]),
    [prefs, setPrefs] = useState<Record<string, boolean> | null>(null),
    [config, setConfig] = useState<any>(null),
    [menu, setMenu] = useState(false);
  const timeBase = useRef({ server: Date.now(), local: performance.now() }),
    requestSeq = useRef(0),
    pendingMutation = useRef<Promise<any> | null>(null),
    activeUser = useRef<string | null>(null);
  const today = minskDate(now),
    isAdmin = user?.role === "admin";
  function setModal(value: Modal | null) {
    setError("");
    updateModal(value);
  }
  function serverClock(iso: string) {
    timeBase.current = { server: Date.parse(iso), local: performance.now() };
    setNow(new Date(iso));
  }
  function navigate(v: View) {
    if (v === "home") setAnchor(minskDate(now));
    setView(v);
    setMenu(false);
    window.location.hash = v;
    setError("");
  }
  useEffect(() => {
    let live = true;
    api("/auth/me")
      .then((result) => {
        if (!live) return;
        setCsrf(result.csrf);
        activeUser.current = result.user.id;
        setUser(result.user);
        setConfig(result);
        serverClock(result.server_now);
        setAnchor(minskDate(result.server_now));
        sessionStorage.setItem("rcs-user", JSON.stringify(result.user));
      })
      .catch(async (e) => {
        if (e instanceof ApiError && e.status === 401) {
          await forget();
        }
        if (!(e instanceof ApiError)) {
          const saved = sessionStorage.getItem("rcs-user");
          if (saved) {
            const u = JSON.parse(saved);
            if (live) {
              activeUser.current = u.id;
              setUser(u);
              setOffline(true);
            }
          }
        }
      })
      .finally(() => {
        if (live) setBoot(false);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const interval = setInterval(
      () =>
        setNow(
          new Date(
            timeBase.current.server +
              performance.now() -
              timeBase.current.local,
          ),
        ),
      15000,
    );
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    const update = () => {
      const part = location.hash.slice(1);
      if (part.startsWith("shift:") && user) {
        api<Shift>("/shifts/" + part.slice(6))
          .then((s) => setModal({ kind: "detail", shift: s }))
          .catch((e) => setError(e.message));
        return;
      }
      if (part in titles) setView(part as View);
    };
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, [user]);
  async function confirmCurrentSession(id: string) {
    // A credential update can revoke the old SSE session before its response
    // installs the new cookie. Wait for that update before checking access.
    await pendingMutation.current?.catch(() => {});
    if (activeUser.current !== id) return false;
    try {
      const me = await api("/auth/me");
      if (activeUser.current !== id || me.user.id !== id) return false;
      setCsrf(me.csrf);
      return true;
    } catch (error: any) {
      if (error.status === 401 && activeUser.current === id) await forget();
      return false;
    }
  }
  async function load() {
    if (!user || user.must_change_password) return;
    const id = user.id,
      seq = ++requestSeq.current;
    setLoading(true);
    const [from, gridTo] = monthGridRange(anchor),
      tomorrow = addDays(minskDate(now), 1),
      to = anchor.slice(0, 7) === minskDate(now).slice(0, 7) && tomorrow > gridTo ? tomorrow : gridTo,
      range = `from=${from}&to=${to}`;
    try {
      const [shifts, mine, team, types, listings, notices, payroll, me] =
        await Promise.all([
          api<Shift[]>("/schedule?" + range),
          api<Shift[]>("/me/shifts?" + range),
          api<any[]>("/team"),
          api<ShiftType[]>("/shift-types"),
          api<Listing[]>("/exchange"),
          api<Notice[]>("/notifications"),
          api<PayrollRow[]>((isAdmin ? "/payroll?" : "/me/payroll?") + range),
          api("/auth/me"),
        ]);
      if (seq !== requestSeq.current || activeUser.current !== id) return;
      const snapshot = {
        shifts,
        mine,
        team,
        types,
        listings,
        notices,
        payroll,
        synced: me.server_now,
      };
      setData(snapshot);
      serverClock(me.server_now);
      setOffline(false);
      setConfig(me);
      setUser((current) => current && current.id === me.user.id && current.version !== me.user.version ? me.user : current);
      sessionStorage.setItem("rcs-user", JSON.stringify(me.user));
      setError("");
      await cacheWrite(id, snapshot).catch(() => {});
    } catch (e: any) {
      if (activeUser.current !== id || seq !== requestSeq.current) return;
      if (e.status === 401) {
        if (await confirmCurrentSession(id)) void load();
        return;
      }
      if (!navigator.onLine || !(e instanceof ApiError)) {
        setOffline(true);
        const cached = await cacheRead(id).catch(() => null);
        if (cached && seq === requestSeq.current) setData(cached);
      } else setError(e.message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [user?.id, user?.must_change_password, anchor]);
  useEffect(() => {
    if (!user || user.must_change_password) return;
    let disposed = false;
    let source: EventSource | null = null,
      timer: ReturnType<typeof setInterval> | undefined;
    const changed = () => {
      void load();
    };
    if (nativeApp) {
      let revision = "",
        polling = false;
      timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          const update = await api("/revision");
          if (update.revision !== revision) {
            revision = update.revision;
            changed();
          }
        } catch (e: any) {
          if (e.status === 401 && await confirmCurrentSession(user.id) && !disposed) changed();
        } finally {
          polling = false;
        }
      }, 2000);
    }
    const connect = () => {
      if (nativeApp || disposed) return;
      source?.close();
      source = new EventSource("/api/events");
      source.addEventListener("change", changed);
      source.addEventListener("revoked", () => {
        source?.close();
        void confirmCurrentSession(user.id).then((valid) => { if (valid && !disposed) { connect(); changed(); } });
      });
    };
    connect();
    window.addEventListener("rcs-push-revoked", connect);
    const online = () => {
        void load();
      },
      offlineEvent = () => setOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", offlineEvent);
    return () => {
      disposed = true;
      source?.close();
      if (timer) clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offlineEvent);
      window.removeEventListener("rcs-push-revoked", connect);
    };
  }, [user?.id, user?.must_change_password, anchor]);
  useEffect(() => {
    if (!user || user.must_change_password) return;
    if (view === "employees" && isAdmin)
      api<User[]>("/employees")
        .then(setEmployees)
        .catch((e) => setError(e.message));
    if (view === "audit" && isAdmin)
      api<Audit[]>("/audit-logs")
        .then(setAuditRows)
        .catch((e) => setError(e.message));
    if (view === "exchange")
      api<Listing[]>("/exchange?history=true")
        .then(setHistory)
        .catch((e) => setError(e.message));
    if (view === "profile")
      api("/me/preferences")
        .then(setPrefs)
        .catch((e) => setError(e.message));
  }, [view, user?.id, data]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (
      user &&
      !user.must_change_password &&
      !nativeApp &&
      config?.push_ready &&
      !offline &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      localStorage.getItem("rcs-push-user") === user.id
    ) {
      // Refresh an already approved subscription; never prompt on page load.
      void registerPushDevice(config, user.id).catch(() => {});
    }
  }, [user?.id, user?.must_change_password, config?.push_ready, offline]);
  useEffect(() => {
    if (!nativeApp || !user || user.must_change_password || offline || !config?.push_android_ready || import.meta.env.VITE_NATIVE_FIREBASE_CONFIGURED !== "true") return;
    if (import.meta.env.VITE_NATIVE_FIREBASE_PROJECT_ID && import.meta.env.VITE_NATIVE_FIREBASE_PROJECT_ID !== config?.push_project_id) return;
    const refresh = () => {
      if (localStorage.getItem("rcs-push-user") !== user.id) return;
      void import("./native-push").then(({ registerNativePushDevice }) => registerNativePushDevice(user.id)).catch(() => {});
    };
    refresh();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [user?.id, user?.must_change_password, config?.push_android_ready, config?.push_project_id, offline]);
  async function forget() {
    void clearPushRegistration(config);
    activeUser.current = null;
    requestSeq.current++;
    setUser(null);
    setData(empty);
    setEmployees([]);
    setAuditRows([]);
    setHistory([]);
    setPrefs(null);
    setConfig(null);
    setModal(null);
    setView("home");
    window.history.replaceState(null, "", window.location.pathname + window.location.search + "#home");
    setAnchor(minskDate());
    setMenu(false);
    setToast("");
    setEmployeeArchive(false);
    setTypeArchive(false);
    setCsrf("");
    sessionStorage.removeItem("rcs-user");
    await cacheClear().catch(() => {});
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_PRIVATE" });
  }
  useEffect(() => {
    const revoked = () => { void clearPushRegistration(config); };
    window.addEventListener("rcs-push-revoked", revoked);
    return () => window.removeEventListener("rcs-push-revoked", revoked);
  }, [config]);
  async function logout() {
    try {
      const deviceId = localStorage.getItem("rcs-push-device");
      if (deviceId) await api("/me/push-devices", "DELETE", { id: deviceId });
      await api("/auth/logout", "POST");
      localStorage.removeItem("rcs-push-device");
      localStorage.removeItem("rcs-push-user");
      await forget();
    } catch (e: any) {
      setError("Для выхода и отзыва сессии восстановите подключение");
    }
  }
  async function act(action: () => Promise<any>, message = "Готово") {
    if (offline) {
      setError("Для этого действия нужно подключение к интернету");
      return;
    }
    setBusy(true);
    setError("");
    let pending: Promise<any> | undefined;
    try {
      pending = action();
      pendingMutation.current = pending;
      await pending;
      setModal(null);
      setToast(message);
      await load();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      if (pendingMutation.current === pending) pendingMutation.current = null;
      setBusy(false);
    }
  }
  async function openQuote(l: Listing) {
    setBusy(true);
    setError("");
    try {
      const q = await api(`/exchange/${l.id}/quote`);
      setModal({
        kind: "take",
        listing: l,
        quote: q,
        key: crypto.randomUUID(),
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const nextShift = data.mine.find(
    (s) => new Date(s.end_at) > now && s.status !== "cancelled",
  );
  const todayShifts = data.shifts.filter(
      (s) => s.date === today && s.status !== "cancelled",
    ),
    tomorrowShifts = data.mine.filter((s) => s.date === addDays(today, 1) && s.status !== "cancelled"),
    monthShiftCount = (isAdmin ? data.shifts : data.mine).filter((s) => s.date.startsWith(anchor.slice(0, 7)) && s.status !== "cancelled").length,
    monthPayroll = data.payroll.filter((p) =>
      p.date.startsWith(anchor.slice(0, 7)),
    ),
    totalMinutes = monthPayroll.reduce((a, p) => a + p.minutes, 0),
    totalAmount = monthPayroll.reduce((a, p) => a + Number(p.amount), 0),
    plannedAmount = monthPayroll.reduce(
      (a, p) => a + Number(p.planned_amount),
      0,
    ),
    unread = data.notices.filter((n) => !n.read_at).length;
  if (boot)
    return (
      <div className="boot">
        <Brand />
        <span className="spinner" />
        Готовим вашу смену…
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(result) => {
          activeUser.current = result.user.id;
          setUser(result.user);
          setCsrf(result.csrf);
          serverClock(result.server_now);
          setAnchor(minskDate(result.server_now));
          setView("home");
          setMenu(false);
          window.location.hash = "home";
          setError("");
          sessionStorage.setItem("rcs-user", JSON.stringify(result.user));
        }}
      />
    );
  if (user.must_change_password)
    return (
      <div className="password-page">
        <Brand />
        <div className="panel">
          <h1>Задайте свой пароль</h1>
          <p>Для первого входа замените временный пароль.</p>
          <Form
            onSubmit={(b) =>
              act(async () => {
                await api("/auth/password", "POST", {
                  current: b.current,
                  password: b.password,
                });
                const r = await api("/auth/me");
                setUser(r.user);
              }, "Пароль обновлён")
            }
          >
            <Field label="Временный пароль">
              <input
                type="password"
                name="current"
                required
                autoComplete="current-password"
              />
            </Field>
            <Field label="Новый пароль">
              <input
                type="password"
                name="password"
                minLength={10}
                required
                autoComplete="new-password"
              />
            </Field>
            <button className="btn primary" disabled={busy}>
              Сохранить пароль
            </button>
          </Form>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  const restricted = ["employees", "types", "audit"].includes(view) && !isAdmin;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <a href="#home" className="brand-link" onClick={() => navigate("home")}>
          <Brand />
          <span className="brand-sub">COFFEE. PEOPLE. SCHEDULE.</span>
        </a>
        <div className="workspace-label">
          <span className="coffee-square">
            <Coffee size={18} />
          </span>
          <div>
            Наша кофейня<small>Одна команда. Один ритм.</small>
          </div>
        </div>
        <div className="nav-heading">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav>
          {navItems
            .filter(
              ([id]) =>
                isAdmin || !["employees", "types", "audit"].includes(id),
            )
            .map(([id, title, Icon]) => (
              <button
                key={id}
                className={view === id ? "nav-item active" : "nav-item"}
                onClick={() => navigate(id)}
              >
                <Icon size={19} />
                <span>
                  {!isAdmin && id === "home"
                    ? "Сегодня"
                    : !isAdmin && id === "payroll"
                      ? "Мои начисления"
                      : title}
                </span>
                {id === "exchange" && data.listings.length > 0 && (
                  <b className="nav-counter">{data.listings.length}</b>
                )}
                {id === "notifications" && unread > 0 && (
                  <span className="unread-dot" />
                )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="time-note">
            <span className="live-dot" />
            Время команды — Минск<small>Europe/Minsk · UTC+3</small>
          </div>
          <button
            className={`nav-item ${view === "profile" ? "active" : ""}`}
            onClick={() => navigate("profile")}
          >
            <Settings size={19} />
            Настройки
          </button>
          <button className="user-block" onClick={() => navigate("profile")}>
            <Avatar name={user.name} src={user.avatar_url} />
            <span>
              {user.name}
              <small>{isAdmin ? "Администратор" : "Бариста"}</small>
            </span>
            <Ellipsis size={18} />
          </button>
        </div>
      </aside>
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Закрыть меню"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu icon-btn"
              aria-label="Открыть меню"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={21} />
            </button>
            <span>Рабочее пространство</span>
            <ChevronRight size={14} />
            <strong>{titles[view]}</strong>
          </div>
          <div className="topbar-right">
            <span className="sync-status">
              <span className={offline ? "offline-dot" : "live-dot"} />
              {offline ? "Нет подключения" : "Синхронизировано"}
            </span>
            <button
              className="icon-btn bell-btn"
              aria-label={`Уведомления: ${unread}`}
              onClick={() => navigate("notifications")}
            >
              <Bell size={20} />
              {unread > 0 && <i />}
            </button>
            <Avatar name={user.name} src={user.avatar_url} small />
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                RCS / {isAdmin ? "УПРАВЛЕНИЕ КОМАНДОЙ" : "МОЯ КОМАНДА"}
              </div>
              <h1>
                {view === "home"
                  ? `${greeting(now)}, ${user.name.split(" ")[0]}`
                  : titles[view]}
                {view === "home" && <span className="heading-dot">.</span>}
              </h1>
              <p>
                {view === "home"
                  ? "Всё, что нужно для хорошей смены, — в одном месте."
                  : subtitles[view]}
              </p>
            </div>
            <div className="heading-actions">
              {view === "home" && (
                <span className="date-pill">
                  <CalendarDays size={17} />
                  {label(today, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              )}
              {isAdmin && ["home", "schedule"].includes(view) && (
                <button
                  className="btn primary"
                  disabled={offline}
                  onClick={() => setModal({ kind: "shift", date: today })}
                >
                  <Plus size={18} />
                  Добавить смену
                </button>
              )}
              {isAdmin && view === "employees" && (
                <button
                  className="btn primary"
                  onClick={() => setModal({ kind: "employee" })}
                >
                  <Plus size={18} />
                  Добавить сотрудника
                </button>
              )}
              {isAdmin && view === "types" && (
                <button
                  className="btn primary"
                  onClick={() => setModal({ kind: "type" })}
                >
                  <Plus size={18} />
                  Новый тип смены
                </button>
              )}
            </div>
          </div>
          {offline && (
            <div className="offline-banner">
              <WifiOff size={18} />
              <span>
                Показаны сохранённые данные
                {data.synced ? ` · ${stamp(data.synced)}` : ""}. Изменения
                доступны после подключения.
              </span>
            </div>
          )}
          {error && !modal && (
            <div className="error-banner" role="alert">
              {error}
              <button
                className="icon-btn"
                aria-label="Закрыть ошибку"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {loading && !data.synced && <div className="loading-line" />}
          {restricted ? (
            <Empty
              icon={LockKeyhole}
              title="Раздел доступен администратору"
              text="Откройте свой график или биржу смен."
            />
          ) : (
            <>
              {view === "home" && (
                <>
                  <div className="dashboard-grid">
                    <section className="hero-card">
                      <div className="hero-copy">
                        <span className="hero-kicker">
                          <span />
                          КОМАНДА В РИТМЕ
                        </span>
                        <h2>
                          {isAdmin ? (
                            <>
                              Хороший день
                              <br />
                              начинается с плана.
                            </>
                          ) : nextShift ? (
                            <>
                              {nextShift.date === today
                                ? "Сегодня"
                                : nextShift.date === addDays(today, 1)
                                  ? "Завтра"
                                  : label(nextShift.date)}
                              <br />
                              {nextShift.start_time} — {nextShift.end_time}
                            </>
                          ) : (
                            <>
                              Сегодня выходной.
                              <br />
                              Время для себя.
                            </>
                          )}
                        </h2>
                        <p>
                          {isAdmin
                            ? `${todayShifts.length} ${plural(todayShifts.length, "смена", "смены", "смен")} сегодня. Всё под контролем.`
                            : nextShift
                              ? nextShift.type_name +
                                " · " +
                                hours(nextShift.minutes ?? 0) +
                                " ч · " +
                                currency(nextShift.amount ?? 0)
                              : "Следующие смены появятся здесь после назначения."}
                        </p>
                        <button
                          className="hero-link"
                          onClick={() =>
                            !isAdmin && nextShift
                              ? setModal({ kind: "detail", shift: nextShift })
                              : navigate("schedule")
                          }
                        >
                          {!isAdmin && nextShift
                            ? "Подробнее о смене"
                            : "Открыть график"}{" "}
                          <ArrowUpRight size={18} />
                        </button>
                      </div>
                      <CoffeeArt />
                    </section>
                    <section className="panel today-card">
                      <div className="section-title">
                        <h2>Сегодня в кофейне</h2>
                        <span className="tag neutral">
                          {label(today, { weekday: "short" })}
                        </span>
                      </div>
                      <div className="today-team">
                        {todayShifts.slice(0, 3).map((s) => (
                          <button
                            className="today-person"
                            key={s.id}
                            onClick={() =>
                              setModal({ kind: "detail", shift: s })
                            }
                          >
                            <Avatar name={s.user_name ?? "?"} src={data.team.find((person) => person.id === s.user_id)?.avatar_url} />
                            <span>
                              <strong>{s.user_name ?? "Не назначен"}</strong>
                              <small>{s.type_name}</small>
                            </span>
                            <b>
                              {s.start_time}
                              <small>{s.end_time}</small>
                            </b>
                          </button>
                        ))}
                        {todayShifts.length === 0 && (
                          <div className="quiet-empty">
                            <Coffee size={28} />
                            <p>Сегодня смен пока нет</p>
                          </div>
                        )}
                      </div>
                      <button
                        className="text-link"
                        onClick={() => {
                          setAnchor(today);
                          navigate("schedule");
                        }}
                      >
                        Весь график на сегодня <ArrowRight size={16} />
                      </button>
                    </section>
                  </div>
                  <div className="stats-grid">
                    {!isAdmin && <>
                      <Stat title="Завтра" value={String(tomorrowShifts.length)} suffix={plural(tomorrowShifts.length, "смена", "смены", "смен")} icon={CalendarDays} footer={tomorrowShifts.map((s) => `${s.start_time}–${s.end_time}`).join(", ") || "Выходной"} onClick={() => { setAnchor(addDays(today, 1)); navigate("schedule"); }} />
                      <Stat title="Заработано сегодня" value={currency(data.payroll.filter((p) => p.date === today).reduce((sum, p) => sum + Number(p.amount), 0)).replace(" Br", "")} suffix="Br" icon={Wallet} footer="По завершённым сменам" onClick={() => navigate("payroll")} />
                    </>}
                    <Stat
                      title={
                        isAdmin ? "Смен в этом месяце" : "Мои смены в месяце"
                      }
                      value={String(monthShiftCount)}
                      suffix={plural(monthShiftCount, "смена", "смены", "смен")}
                      icon={CalendarDays}
                      footer={label(anchor, { month: "long", year: "numeric" })}
                    />
                    <Stat
                      title="Отработано"
                      value={hours(totalMinutes)}
                      suffix="часов"
                      icon={Clock}
                      footer="Без вычета перерывов"
                    />
                    <Stat
                      title={isAdmin ? "Начислено команде" : "Мои начисления"}
                      value={currency(totalAmount).replace(" Br", "")}
                      suffix="Br"
                      icon={Wallet}
                      footer="По завершённым сменам"
                    />
                    <Stat
                      title="Открыто на бирже"
                      value={String(data.listings.length)}
                      suffix={plural(data.listings.length, "смена", "смены", "смен")}
                      icon={ArrowLeftRight}
                      footer="Можно забрать без согласования"
                      accent
                      onClick={() => navigate("exchange")}
                    />
                  </div>
                  {!isAdmin && (
                    <NextShift
                      shifts={data.mine}
                      now={now}
                      open={(s) => setModal({ kind: "detail", shift: s })}
                    />
                  )}
                  <Schedule
                    shifts={data.shifts}
                    mine={data.mine}
                    team={data.team}
                    anchor={anchor}
                    setAnchor={setAnchor}
                    today={today}
                    admin={isAdmin}
                    open={(s) => setModal({ kind: "detail", shift: s })}
                    create={(date, userId) =>
                      setModal({ kind: "shift", date, userId })
                    }
                    compact
                  />
                  <div className="bottom-grid">
                    <section className="panel market-banner">
                      <span className="market-icon">
                        <ArrowLeftRight size={25} />
                      </span>
                      <div>
                        <div className="eyebrow">ПОДХВАТИ СМЕНУ</div>
                        <h3>
                          У команды есть{" "}
                          {data.listings.length
                            ? `${data.listings.length} ${plural(data.listings.length, "открытая смена", "открытые смены", "открытых смен")}`
                            : "пространство для манёвра"}
                        </h3>
                        <p>Выбирай удобное время и присоединяйся.</p>
                      </div>
                      <button
                        className="btn"
                        onClick={() => navigate("exchange")}
                      >
                        На биржу <ArrowUpRight size={16} />
                      </button>
                    </section>
                    <div className="team-note">
                      <Coffee size={22} />
                      <p>
                        Отличный кофе делают люди.
                        <br />
                        <strong>А мы помогаем быть вовремя.</strong>
                      </p>
                    </div>
                  </div>
                </>
              )}
              {view === "schedule" && (
                <Schedule
                  shifts={data.shifts}
                  mine={data.mine}
                  team={data.team}
                  anchor={anchor}
                  setAnchor={setAnchor}
                  today={today}
                  admin={isAdmin}
                  open={(s) => setModal({ kind: "detail", shift: s })}
                  create={(date, userId) =>
                    setModal({ kind: "shift", date, userId })
                  }
                />
              )}
              {view === "exchange" && (
                <>
                  <div className="info-strip">
                    <ShieldCheck size={21} />
                    <div>
                      <strong>Забирайте смены без ожидания</strong>
                      <span>
                        Забрать смену можно ежедневно с 10:00 до 19:00 по Минску,
                        до её начала. В остальное время можно посмотреть условия.
                      </span>
                    </div>
                  </div>
                  <div className="section-title standalone">
                    <h2>
                      Открытые смены{" "}
                      <span className="count-label">
                        {data.listings.length}
                      </span>
                    </h2>
                    <span className="muted">Обновляются автоматически</span>
                  </div>
                  <div className="exchange-grid">
                    {data.listings.map((l) => (
                      <section className="panel listing-card" key={l.id} data-listing-id={l.id}>
                        <div className="section-title">
                          <span className="tag red">На бирже</span>
                          <span className="muted">
                            {label(l.date, { weekday: "short" })}
                          </span>
                        </div>
                        <h3>{label(l.date)}</h3>
                        <div className="listing-time">
                          {l.start_time}
                          <span>—</span>
                          {l.end_time}
                        </div>
                        <div className="listing-type">
                          <Coffee size={16} />
                          {l.type_name}
                          <span>·</span>
                          {hours(
                            (Date.parse("2000-01-01T" + l.end_time) -
                              Date.parse("2000-01-01T" + l.start_time)) /
                              60000,
                          )}{" "}
                          ч
                        </div>
                        <div className="listing-owner">
                          <Avatar name={l.user_name} src={data.team.find((u) => u.id === l.user_id)?.avatar_url} small />
                          <span>Передаёт {l.user_name}</span>
                        </div>
                        <div className="listing-deadline">
                          <Clock size={14} />
                          До {stamp(l.closes_at)} · Минск
                        </div>
                        {l.user_id === user.id || isAdmin ? (
                          <button
                            className="btn full"
                            disabled={busy || offline}
                            onClick={() =>
                              act(
                                () => api(`/exchange/${l.id}/withdraw`, "POST"),
                                "Объявление отозвано",
                              )
                            }
                          >
                            Отозвать объявление
                          </button>
                        ) : (
                          <button
                            className="btn primary full"
                            disabled={busy || offline}
                            onClick={() => openQuote(l)}
                          >
                            {canTakeExchangeAt(now) ? "Посмотреть и забрать" : "Посмотреть условия"} <ArrowUpRight size={16} />
                          </button>
                        )}
                      </section>
                    ))}
                  </div>
                  {!data.listings.length && (
                    <Empty
                      icon={ArrowLeftRight}
                      title="Сейчас все смены у своих людей"
                      text="Новые предложения появятся здесь автоматически. Свою смену можно выставить из графика."
                    />
                  )}
                  <section className="panel history-panel">
                    <h2>История передач</h2>
                    {history.length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Смена</th>
                              <th>Передал</th>
                              <th>Получил</th>
                              <th>Статус</th>
                              {isAdmin && <th />}
                            </tr>
                          </thead>
                          <tbody>
                            {history
                              .filter((l) => l.status !== "open")
                              .map((l) => (
                                <tr key={l.id}>
                                  <td>
                                    {label(l.date)} · {l.start_time}
                                  </td>
                                  <td>{l.user_name}</td>
                                  <td>{l.taken_name ?? "—"}</td>
                                  <td>
                                    <span className="tag neutral">
                                      {listingLabels[l.status] ?? l.status}
                                    </span>
                                  </td>
                                  {isAdmin && (
                                    <td>
                                      {l.status === "taken" && (
                                        <button
                                          className="text-link"
                                          onClick={() =>
                                            setModal({
                                              kind: "reason",
                                              title: "Причина отката обмена",
                                              action: (reason) =>
                                                api(
                                                  `/exchange/${l.id}/rollback`,
                                                  "POST",
                                                  { reason },
                                                ),
                                            })
                                          }
                                        >
                                          Откатить
                                        </button>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="muted">Передач пока нет.</p>
                    )}
                  </section>
                </>
              )}
              {view === "employees" && isAdmin && (
                <>
                  <div className="section-title standalone">
                    <h2>
                      Люди, которые делают кофе{" "}
                      <span className="count-label">
                        {employees.filter((e) => e.active).length}
                      </span>
                    </h2>
                    <button className={`btn tiny ${employeeArchive ? "selected" : ""}`} aria-pressed={employeeArchive} onClick={() => setEmployeeArchive(!employeeArchive)}>
                      {employeeArchive ? "Показать команду" : "Архив сотрудников"}
                    </button>
                  </div>
                  <div className="employee-grid">
                    {employees.filter((e) => employeeArchive ? !e.active : e.active).map((e) => (
                      <section
                        className={`panel employee-card ${!e.active ? "inactive" : ""}`}
                        key={e.id}
                      >
                        <div className="section-title">
                          <Avatar name={e.name} src={e.avatar_url} />
                          <span
                            className={`tag ${e.active ? "neutral" : "red"}`}
                          >
                            {e.active ? "В команде" : "В архиве"}
                          </span>
                        </div>
                        <h3>{e.name}</h3>
                        <p>
                          {e.role === "admin" ? "Администратор" : "Бариста"}
                        </p>
                        <div className="employee-info">
                          <span>{e.phone}</span>
                          <strong>
                            {e.rate
                              ? `${currency(e.rate)} / ${e.pay_type === "hourly" ? "час" : "смену"}`
                              : e.pay_type === "hourly" ? "Ставка в час не задана" : "Ставка по типу смены"}
                          </strong>
                        </div>
                        <button
                          className="btn full"
                          onClick={() =>
                            setModal({ kind: "employee", employee: e })
                          }
                        >
                          Редактировать профиль <ArrowUpRight size={15} />
                        </button>
                        {e.role === "barista" && (
                          <button
                            className="btn full rate-edit-button"
                            disabled={offline}
                            onClick={() =>
                              setModal({ kind: "rate", employee: e })
                            }
                          >
                            <Wallet size={15} />
                            Изменить ставку в час
                          </button>
                        )}
                        {e.active && (
                          <button className="btn full delete-entity-button" disabled={offline || busy || e.id === user.id} title={e.id === user.id ? "Нельзя удалить свой аккаунт" : undefined} onClick={() => setModal({ kind: "deleteEmployee", employee: e })}>
                            <Trash2 size={15} />Удалить сотрудника
                          </button>
                        )}
                      </section>
                    ))}
                  </div>
                  {!employees.some((e) => employeeArchive ? !e.active : e.active) && (
                    <Empty
                      icon={Users}
                      title={employeeArchive ? "Архив сотрудников пуст" : "Добавьте команду"}
                      text={employeeArchive ? "Удалённые сотрудники появятся здесь. Чтобы вернуть сотрудника, включите его профиль." : "Создайте профили сотрудников и назначьте первые смены."}
                    />
                  )}
                </>
              )}
              {view === "types" && isAdmin && (
                <>
                <div className="section-title standalone">
                  <h2>{typeArchive ? "Архив типов смен" : "Действующие типы смен"}</h2>
                  <button className={`btn tiny ${typeArchive ? "selected" : ""}`} aria-pressed={typeArchive} onClick={() => setTypeArchive(!typeArchive)}>{typeArchive ? "Показать действующие" : "Архив типов смен"}</button>
                </div>
                <div className="employee-grid">
                  {data.types.filter((t) => typeArchive ? !t.active : t.active).map((t) => (
                    <section
                      className={`panel type-card ${!t.active ? "inactive" : ""}`}
                      key={t.id}
                    >
                      <div className="section-title">
                        <span className="type-number">{t.name[0]}</span>
                        <span className="tag neutral">
                          {t.active ? "Активен" : "В архиве"}
                        </span>
                      </div>
                      <h3>{t.name}</h3>
                      <div className="type-hours">
                        {t.start_time.slice(0, 5)} — {t.end_time.slice(0, 5)}
                      </div>
                      {t.pay_type === "shift" && <strong>{currency(t.rate)} / смену</strong>}
                      <p className="muted">
                        {t.allow_exchange
                          ? "Можно передавать через биржу"
                          : "Биржа для типа отключена"}
                      </p>
                      <button
                        className="btn full"
                        onClick={() => setModal({ kind: "type", type: t })}
                      >
                        Настроить тип <SlidersHorizontal size={15} />
                      </button>
                      {t.active && (
                        <button className="btn full delete-entity-button" disabled={offline || busy} onClick={() => setModal({ kind: "deleteType", type: t })}>
                          <Trash2 size={15} />Удалить тип смены
                        </button>
                      )}
                    </section>
                  ))}
                  {!data.types.some((t) => typeArchive ? !t.active : t.active) && (
                    <Empty
                      icon={Layers}
                      title={typeArchive ? "Архив типов смен пуст" : "Создайте первый тип смены"}
                      text={typeArchive ? "Удалённые типы появятся здесь. Их можно вернуть через настройки типа." : "Например, открытие с 08:00 до 15:00."}
                    />
                  )}
                </div>
                </>
              )}
              {view === "payroll" && (
                <>
                  <div className="panel payroll-summary">
                    <MonthPager anchor={anchor} setAnchor={setAnchor} />
                    <div className="payroll-numbers">
                      <div>
                        <span>Отработано</span>
                        <strong>
                          {hours(totalMinutes)} <small>ч</small>
                        </strong>
                      </div>
                      <div>
                        <span>Начислено</span>
                        <strong>{currency(totalAmount)}</strong>
                      </div>
                      <div>
                        <span>Ожидается по плану</span>
                        <strong className="muted">
                          {currency(plannedAmount)}
                        </strong>
                      </div>
                    </div>
                    <p className="muted">
                      Внутренний информационный расчёт. Перерывы не вычитаются.
                    </p>
                  </div>
                  {monthPayroll.length > 0 && <>
                    {isAdmin && <PayrollTotals title="Итоги по сотрудникам" rows={monthPayroll} group="employee" />}
                    <PayrollTotals title="Итоги по неделям" rows={monthPayroll} group="week" />
                  </>}
                  <section className="panel">
                    <div className="section-title padded">
                      <h2>Начисления по дням</h2>
                      <span className="tag neutral">BYN</span>
                    </div>
                    {monthPayroll.length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Дата</th>
                              {isAdmin && <th>Сотрудник</th>}
                              <th>Отработано</th>
                              <th>Начислено</th>
                              <th>План, ч</th>
                              <th>Ожидается</th>
                            </tr>
                          </thead>
                          <tbody>
                            {monthPayroll.map((p) => (
                              <tr key={p.user_id + p.date}>
                                <td>
                                  {label(p.date, {
                                    day: "2-digit",
                                    month: "2-digit",
                                    year: "numeric",
                                  })}
                                </td>
                                {isAdmin && (
                                  <td>
                                    <span className="inline-person">
                                      <Avatar name={p.name} src={data.team.find((u) => u.id === p.user_id)?.avatar_url} small />
                                      {p.name}
                                    </span>
                                  </td>
                                )}
                                <td>{hours(p.minutes)} ч</td>
                                <td>
                                  <strong>{currency(p.amount)}</strong>
                                </td>
                                <td>{hours(p.planned_minutes)}</td>
                                <td className="muted">
                                  {currency(p.planned_amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty
                        icon={Wallet}
                        title="В этом месяце начислений пока нет"
                        text="Здесь появятся часы и оплата назначенных смен."
                      />
                    )}
                  </section>
                </>
              )}
              {view === "notifications" && (
                <section className="panel">
                  <div className="section-title padded">
                    <h2>
                      Все события{" "}
                      <span className="count-label">{unread} новых</span>
                    </h2>
                    <div className="inline-actions">
                      {isAdmin && (
                        <button
                          className="btn"
                          onClick={() => setModal({ kind: "message" })}
                        >
                          <Send size={15} />
                          Отправить
                        </button>
                      )}
                      <button
                        className="text-link"
                        onClick={() =>
                          act(
                            () => api("/notifications/read", "POST"),
                            "Уведомления прочитаны",
                          )
                        }
                      >
                        <CheckCheck size={17} />
                        Прочитать все
                      </button>
                    </div>
                  </div>
                  {data.notices.map((n) => (
                    <button
                      className={`notice ${!n.read_at ? "new" : ""}`}
                      key={n.id}
                      onClick={async () => {
                        try {
                          await api(`/notifications/${n.id}/read`, "POST");
                          setData((current) => ({ ...current, notices: current.notices.map((notice) => notice.id === n.id ? { ...notice, read_at: now.toISOString() } : notice) }));
                        } catch (e: any) { setError(e.message); return; }
                        if (n.link.startsWith("shift:")) {
                          api<Shift>("/shifts/" + n.link.slice(6))
                            .then((s) => setModal({ kind: "detail", shift: s }))
                            .catch((e) => setError(e.message));
                        } else
                          navigate(
                            n.link in titles ? (n.link as View) : "schedule",
                          );
                      }}
                    >
                      <span className="notice-icon">
                        <Bell size={18} />
                      </span>
                      <div>
                        <strong>{n.title}</strong>
                        <p>{n.body}</p>
                        <small>{stamp(n.created_at)}</small>
                      </div>
                      {!n.read_at && <span className="unread-dot" />}
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                  {!data.notices.length && (
                    <Empty
                      icon={Bell}
                      title="Пока тихо"
                      text="Изменения графика и события команды появятся здесь."
                    />
                  )}
                </section>
              )}
              {view === "audit" && isAdmin && (
                <section className="panel">
                  <div className="section-title padded">
                    <h2>Последние 100 действий</h2>
                    <span className="tag neutral">Europe/Minsk</span>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Время</th>
                          <th>Кто</th>
                          <th>Действие</th>
                          <th>Причина</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditRows.map((a) => (
                          <tr key={a.id}>
                            <td className="nowrap">{stamp(a.created_at)}</td>
                            <td>{a.actor_name ?? "Система"}</td>
                            <td>{a.action}{a.entity === "shift" && a.after_value && typeof a.after_value === "object" && "type_name" in a.after_value ? <small className="audit-detail">{String((a.after_value as any).date)} · {String((a.after_value as any).start_time)}–{String((a.after_value as any).end_time)} · {String((a.after_value as any).type_name)} · {String((a.after_value as any).user_name)}</small> : null}</td>
                            <td className="muted">{a.reason ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!auditRows.length && (
                    <Empty
                      icon={History}
                      title="История начинается здесь"
                      text="Изменения будут сохранены с автором и временем."
                    />
                  )}
                </section>
              )}
              {view === "profile" && (
                <div className="profile-grid">
                  <section className="panel profile-card">
                    <Avatar name={user.name} src={user.avatar_url} />
                    <h2>{user.name}</h2>
                    <span className="tag neutral">
                      {isAdmin ? "Администратор" : "Бариста"}
                    </span>
                    <p>{user.phone}</p>
                    <button className="btn full" disabled={offline || busy} onClick={() => setModal({ kind: "name" })}><Users size={16} />Изменить имя и фамилию</button>
                    <AvatarSettings user={user} offline={offline} saved={(updated) => {
                      setUser(updated);
                      sessionStorage.setItem("rcs-user", JSON.stringify(updated));
                      setToast("Аватарка обновлена");
                      void load();
                    }} />
                    {isAdmin && <button className="btn full account-edit-button" disabled={offline || busy} onClick={() => setModal({ kind: "account" })}><Settings size={16} />Изменить телефон и пароль</button>}
                    <div className="profile-fact">
                      <Clock size={18} />
                      Europe/Minsk · UTC+3
                    </div>
                    {nativeApp && (
                      <button
                        className="btn full"
                        style={{ marginBottom: 10 }}
                        onClick={() =>
                          window.dispatchEvent(new Event("rcs-change-server"))
                        }
                      >
                        <Settings size={16} />
                        Сервер: {new URL(serverBase()).hostname}
                      </button>
                    )}
                    <button className="btn full" onClick={logout}>
                      <LogOut size={17} />
                      Выйти из аккаунта
                    </button>
                  </section>
                  <section className="panel preferences">
                    <ThemeSettings />
                    <h2>Уведомления</h2>
                    <p className="muted">
                      История событий остаётся в приложении, даже если push
                      отключены.
                    </p>
                    {prefs &&
                      Object.entries(prefLabels).map(([key, title]) => (
                        <label className="toggle-row" key={key}>
                          <span>{title}</span>
                          <input
                            type="checkbox"
                            checked={prefs[key] ?? false}
                            disabled={offline || busy}
                            onChange={(e) => {
                              const updated = {
                                ...prefs,
                                [key]: e.target.checked,
                              };
                              void act(async () => {
                                await api("/me/preferences", "PATCH", updated);
                                setPrefs(updated);
                              }, "Настройки сохранены");
                            }}
                          />
                        </label>
                      ))}
                    <PushControls
                      key={user.version}
                      userId={user.id}
                      admin={isAdmin}
                      config={config}
                      offline={offline}
                      report={setToast}
                    />
                    <details className="password-details">
                      <summary>Сменить пароль</summary>
                      <Form
                        onSubmit={(b) =>
                          act(
                            () =>
                              api("/auth/password", "POST", {
                                current: b.current,
                                password: b.password,
                              }),
                            "Пароль изменён",
                          )
                        }
                      >
                        <Field label="Текущий пароль">
                          <input
                            type="password"
                            name="current"
                            autoComplete="current-password"
                            required
                          />
                        </Field>
                        <Field label="Новый пароль">
                          <input
                            type="password"
                            name="password"
                            minLength={10}
                            autoComplete="new-password"
                            required
                          />
                        </Field>
                        <button className="btn" disabled={busy}>
                          Сменить пароль
                        </button>
                      </Form>
                    </details>
                  </section>
                </div>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              RCS<span className="heading-dot">.</span>{" "}
              <span>Собираем команду. Создаём ритм.</span>
            </span>
            <span>Одна кофейня — одна команда</span>
          </footer>
        </main>
      </div>
      {!isAdmin && (
        <nav className="bottom-nav">
          {(
            [
              ["home", "Сегодня", Coffee],
              ["schedule", "График", CalendarDays],
              ["exchange", "Биржа", ArrowLeftRight],
              ["profile", "Профиль", Users],
            ] as const
          ).map(([id, title, Icon]) => (
            <button
              className={view === id ? "active" : ""}
              key={id}
              onClick={() => navigate(id)}
            >
              <Icon size={21} />
              <span>{title}</span>
            </button>
          ))}
        </nav>
      )}
      {toast && (
        <div role="status" className="toast">
          <CheckCircle2 size={19} />
          {toast}
        </div>
      )}
      {modal && (
        <ModalDialog
          key={modal.kind}
          modal={modal}
          close={() => {
            setModal(null);
            setError("");
          }}
          data={data}
          user={user}
          busy={busy}
          error={error}
          offline={offline}
          now={now}
          act={act}
          setModal={setModal}
          onAssigned={(date) => { setAnchor(date); navigate("schedule"); }}
        />
      )}
    </div>
  );
}

const subtitles: Record<View, string> = {
  home: "",
  schedule: "Планируйте смены. Держите команду в одном ритме.",
  exchange: "Помогайте друг другу и выбирайте удобные смены.",
  employees: "Люди, на которых держится наша кофейня.",
  types: "Настройте время, оплату и правила для каждой смены.",
  payroll: "Прозрачный расчёт времени и оплаты в белорусских рублях.",
  notifications: "Будьте в курсе изменений в своей команде.",
  audit: "Каждое изменение — с автором, временем и причиной.",
  profile: "Ваш аккаунт и удобный ритм уведомлений.",
};
const listingLabels: Record<string, string> = {
  open: "Открыта",
  taken: "Передана",
  cancelled: "Отозвана",
  closed: "Закрыта автоматически",
  expired: "Срок истёк",
  rolled_back: "Откат админом",
};
const prefLabels: Record<string, string> = {
  schedule: "Назначения и изменения графика",
  exchange: "События биржи смен",
  adjustments: "Корректировки часов и оплаты",
  admin: "Сообщения администратора",
  reminder_120: "Напоминание за 2 часа",
  reminder_60: "Напоминание за 1 час",
};
function greeting(now: Date) {
  const h = Number(
    new Intl.DateTimeFormat("en", {
      timeZone: "Europe/Minsk",
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  return h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
}
export function Brand() {
  return (
    <span className="brand">
      RCS<span>.</span>
    </span>
  );
}
export function Avatar({
  name,
  src,
  small = false,
}: {
  name: string;
  src?: string | null;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar ${small ? "small" : ""} tone-${name.charCodeAt(0) % 4}`}
    >
      {src ? <img src={src} alt={`Аватар: ${name}`} /> : initials(name)}
    </span>
  );
}
export function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: any;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <span>
        <Icon size={27} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Stat({
  title,
  value,
  suffix,
  icon: Icon,
  footer,
  accent = false,
  onClick,
}: {
  title: string;
  value: string;
  suffix: string;
  icon: any;
  footer: string;
  accent?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`stat-card ${accent ? "accent" : ""}`}
      onClick={onClick}
      disabled={!onClick}
    >
      <div className="stat-top">
        <span>{title}</span>
        <Icon size={19} />
      </div>
      <div className="stat-value">
        {value}
        <small>{suffix}</small>
      </div>
      <div className="stat-footer">
        {accent && <span className="red-dot" />}
        {footer}
        {onClick && <ArrowUpRight size={14} />}
      </div>
    </button>
  );
}
export function Field({
  label: caption,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<any>, {
        id,
        "aria-describedby": hint ? `${id}-hint` : undefined,
      })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{caption}</label>
      {control}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Form({
  onSubmit,
  children,
}: {
  onSubmit: (data: Record<string, string>) => any;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        void onSubmit(
          Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<
            string,
            string
          >,
        );
      }}
    >
      {children}
    </form>
  );
}
function PayrollTotals({ title, rows, group }: { title: string; rows: PayrollRow[]; group: "employee" | "week" }) {
  const totals = new Map<string, { name: string; minutes: number; amount: number; plannedMinutes: number; plannedAmount: number }>();
  for (const row of rows) {
    const key = group === "employee" ? row.user_id : weekStart(row.date);
    const current = totals.get(key) ?? { name: group === "employee" ? row.name : `${label(key)} – ${label(addDays(key, 6))}`, minutes: 0, amount: 0, plannedMinutes: 0, plannedAmount: 0 };
    current.minutes += row.minutes;
    current.amount += Number(row.amount);
    current.plannedMinutes += row.planned_minutes;
    current.plannedAmount += Number(row.planned_amount);
    totals.set(key, current);
  }
  return <section className="panel payroll-totals"><div className="section-title padded"><h2>{title}</h2>{group === "week" && <span className="muted small">В пределах выбранного месяца</span>}</div><div className="table-scroll"><table><thead><tr><th>{group === "employee" ? "Сотрудник" : "Неделя"}</th><th>Отработано</th><th>Начислено</th><th>План, ч</th><th>Ожидается</th></tr></thead><tbody>{[...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, total]) => <tr key={key}><td>{total.name}</td><td>{hours(total.minutes)} ч</td><td><strong>{currency(total.amount)}</strong></td><td>{hours(total.plannedMinutes)}</td><td>{currency(total.plannedAmount)}</td></tr>)}</tbody></table></div></section>;
}
function MonthPager({
  anchor,
  setAnchor,
}: {
  anchor: string;
  setAnchor: (a: string) => void;
}) {
  return (
    <div className="month-pager">
      <h2>{label(anchor, { month: "long", year: "numeric" })}</h2>
      <div className="inline-actions">
        <button
          className="icon-btn"
          aria-label="Предыдущий месяц"
          onClick={() => setAnchor(moveMonth(anchor, -1))}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="icon-btn"
          aria-label="Следующий месяц"
          onClick={() => setAnchor(moveMonth(anchor, 1))}
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
function NextShift({
  shifts,
  now,
  open,
}: {
  shifts: Shift[];
  now: Date;
  open: (s: Shift) => void;
}) {
  const s = shifts.find(
    (s) => new Date(s.end_at) > now && s.status !== "cancelled",
  );
  return s ? (
    <section className="next-shift panel">
      <span className="next-icon">
        <Coffee size={25} />
      </span>
      <div>
        <span className="eyebrow">СЛЕДУЮЩАЯ СМЕНА</span>
        <h2>
          {label(s.date)} · {s.start_time}–{s.end_time}
        </h2>
        <p>
          {s.type_name} · {hours(s.minutes ?? 0)} ч · Ожидается{" "}
          {currency(s.amount ?? 0)}
        </p>
      </div>
      <button className="btn" onClick={() => open(s)}>
        Подробнее <ArrowUpRight size={16} />
      </button>
    </section>
  ) : null;
}
function Login({ onLogin }: { onLogin: (r: any) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login-page">
      <section className="login-story">
        <Brand />
        <div>
          <span className="hero-kicker">COFFEE. PEOPLE. SCHEDULE.</span>
          <h1>
            Хороший кофе.{" "}
            <br />
            Свои люди.
            <br />
            <span>Общий ритм.</span>
          </h1>
          <p>Расписание, которое работает на команду.</p>
        </div>
        <span className="login-foot">RCS — одна кофейня, одна команда.</span>
        <div className="login-circle" aria-hidden="true">
          <Coffee size={190} strokeWidth={0.7} />
        </div>
      </section>
      <section className="login-form">
        <div className="login-form-inner">
          <span className="tag red">РАБОЧЕЕ ПРОСТРАНСТВО</span>
          <h2>Рады видеть.</h2>
          <p>Войдите, чтобы узнать планы на хорошую смену.</p>
          <Form
            onSubmit={async (b) => {
              setBusy(true);
              setError("");
              try {
                onLogin(
                  await api("/auth/login", "POST", {
                    phone: b.phone,
                    password: b.password,
                  }),
                );
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Телефон">
              <input
                name="phone"
                type="tel"
                placeholder="+375 29 123-45-67"
                autoComplete="username"
                required
              />
            </Field>
            <Field label="Пароль">
              <input
                name="password"
                type="password"
                placeholder="Ваш пароль"
                autoComplete="current-password"
                required
              />
            </Field>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="btn primary full" disabled={busy}>
              {busy ? "Входим…" : "Войти в RCS"}
              <ArrowRight size={18} />
            </button>
          </Form>
          <p className="login-help">
            <LockKeyhole size={15} />
            Доступ выдаёт администратор кофейни
          </p>
        </div>
        <span className="login-time">
          <Clock size={15} />
          Работаем по времени Минска · UTC+3
        </span>
      </section>
    </div>
  );
}

function ModalDialog({
  modal,
  close,
  data,
  user,
  busy,
  error,
  offline,
  now,
  act,
  setModal,
  onAssigned,
}: {
  modal: Modal;
  close: () => void;
  data: Snapshot;
  user: User;
  busy: boolean;
  error: string;
  offline: boolean;
  now: Date;
  act: (fn: () => Promise<any>, message?: string) => Promise<any>;
  setModal: (m: Modal | null) => void;
  onAssigned: (date: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [typePayType, setTypePayType] = useState<"hourly" | "shift">(modal.kind === "type" ? modal.type?.pay_type ?? "hourly" : "hourly"),
    [employeeRole, setEmployeeRole] = useState<"admin" | "barista">(modal.kind === "employee" ? modal.employee?.role ?? "barista" : "barista"),
    [adjustments, setAdjustments] = useState<any[]>([]),
    [selectedType, setSelectedType] = useState(
      modal.kind === "shift"
        ? (modal.shift?.type_id ?? data.types.find((t) => t.active)?.id ?? "")
        : "",
    ),
    [start, setStart] = useState(
      modal.kind === "shift"
        ? (modal.shift?.start_time ??
            data.types.find((t) => t.active)?.start_time.slice(0, 5) ??
            "08:00")
        : "",
    ),
    [end, setEnd] = useState(
      modal.kind === "shift"
        ? (modal.shift?.end_time ??
            data.types.find((t) => t.active)?.end_time.slice(0, 5) ??
            "15:00")
        : "",
    );
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  useEffect(() => {
    if (modal.kind === "detail")
      api(`/adjustments?shift_id=${modal.shift.id}`)
        .then(setAdjustments)
        .catch(() => {});
  }, [modal]);
  const admin = user.role === "admin";
  let title = "",
    body: ReactNode = null;
  if (modal.kind === "shift" && !modal.shift) {
    title = "Назначить смены";
    body = <BatchShiftForm date={modal.date ?? minskDate(now)} userId={modal.userId} types={data.types} team={data.team} busy={busy} offline={offline} close={close} act={act} onAssigned={onAssigned} />;
  }
  if (modal.kind === "shift" && modal.shift) {
    const s = modal.shift;
    title = s ? "Редактировать смену" : "Новая смена";
    body = (
      <Form
        onSubmit={(b) =>
          act(
            () =>
              api(s ? `/shifts/${s.id}` : "/shifts", s ? "PATCH" : "POST", {
                date: b.date,
                start_time: b.start_time,
                end_time: b.end_time,
                type_id: b.type_id,
                user_id: b.user_id || null,
                status: b.status,
                comment: b.comment,
                exchange_locked: b.exchange_locked === "on",
                rate_override: b.rate_override || null,
                ...(s ? { version: s.version, reason: b.reason } : {}),
              }),
            "Смена сохранена",
          )
        }
      >
        <Field label="Дата">
          <input
            type="date"
            name="date"
            defaultValue={s?.date ?? modal.date ?? minskDate(now)}
            required
          />
        </Field>
        <Field label="Тип смены">
          <select
            name="type_id"
            value={selectedType}
            required
            onChange={(e) => {
              setSelectedType(e.target.value);
              const t = data.types.find((t) => t.id === e.target.value);
              if (t) {
                setStart(t.start_time.slice(0, 5));
                setEnd(t.end_time.slice(0, 5));
              }
            }}
          >
            <option value="" disabled>
              Выберите тип
            </option>
            {data.types
              .filter((t) => t.active)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </Field>
        <div className="form-row">
          <Field label="Начало">
            <input
              type="time"
              name="start_time"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="Окончание">
            <input
              type="time"
              name="end_time"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Сотрудник">
          <select
            name="user_id"
            defaultValue={s?.user_id ?? modal.userId ?? ""}
          >
            <option value="">Не назначен</option>
            {data.team.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Статус">
          <select name="status" defaultValue={s?.status ?? "confirmed"}>
            {Object.entries(statusLabels)
              .filter(
                ([status]) => s || ["planned", "confirmed"].includes(status),
              )
              .map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
          </select>
        </Field>
        <Field
          label="Ставка вручную, Br"
          hint={`Сумма ${data.types.find((t) => t.id === selectedType)?.pay_type === "shift" ? "за всю смену" : "за час"}. При ручном вводе используется модель выбранного типа. Пустое поле — оплата по правилам сотрудника или типа.`}
        >
          <input
            name="rate_override"
            inputMode="decimal"
            type="number"
            min={data.types.find((type) => type.id === selectedType)?.pay_type === "shift" ? "0" : "0.01"}
            step="0.01"
            placeholder="Автоматически"
          />
        </Field>
        <Field label="Комментарий">
          <textarea name="comment" defaultValue={s?.comment ?? ""} rows={2} />
        </Field>
        <label className="checkbox-field">
          <input
            type="checkbox"
            name="exchange_locked"
            defaultChecked={s?.exchange_locked}
          />
          Запретить передачу через биржу
        </label>
        {s && (
          <Field label="Причина изменения">
            <input
              name="reason"
              required
              minLength={3}
              placeholder="Что и почему меняется"
            />
          </Field>
        )}
        <div className="modal-footer">
          <button type="button" className="btn" onClick={close}>
            Отмена
          </button>
          <button
            className="btn primary"
            disabled={busy || offline || !data.types.some((t) => t.active)}
          >
            {busy ? "Сохраняем…" : "Сохранить смену"}
          </button>
        </div>
        {!data.types.some((t) => t.active) && (
          <p className="error">Сначала создайте активный тип смены.</p>
        )}
      </Form>
    );
  }
  if (modal.kind === "adjustmentCredit") {
    title = "Уточнить старую корректировку";
    body = <Form onSubmit={(b) => act(() => api(`/adjustments/${modal.adjustment.id}/credit`, "PATCH", { amount: b.amount, reason: b.reason }), "Сумма персональной корректировки уточнена")}>
      <p>Получатель: <strong>{modal.adjustment.user_name}</strong>.</p>
      <p className="muted small">Укажите денежный итог старой корректировки, включая изменение минут. Сотрудник-получатель останется прежним.</p>
      <Field label="Сумма корректировки, Br"><input name="amount" type="number" step="0.01" required /></Field>
      <Field label="Причина уточнения"><input name="reason" minLength={3} maxLength={1000} required /></Field>
      <div className="modal-footer"><button className="btn" type="button" onClick={close}>Отмена</button><button className="btn primary" disabled={busy || offline}>Сохранить</button></div>
    </Form>;
  }
  if (modal.kind === "name") {
    title = "Имя и фамилия";
    body = <Form onSubmit={(b) => act(() => api("/me/name", "PATCH", { name: b.name, version: user.version }), "Имя и фамилия обновлены")}>
      <Field label="Имя и фамилия"><input name="name" defaultValue={user.name} autoComplete="name" required maxLength={200} /></Field>
      <p className="muted small">Новое имя будет видно команде в графике смен.</p>
      <div className="modal-footer"><button className="btn" type="button" onClick={close}>Отмена</button><button className="btn primary" disabled={busy || offline}>Сохранить</button></div>
    </Form>;
  }
  if (modal.kind === "account") {
    title = "Телефон и пароль администратора";
    body = <Form onSubmit={(b) => act(() => api(`/employees/${user.id}`, "PATCH", {
      name: user.name, phone: b.phone, rate: user.rate, pay_type: user.pay_type,
      active: true, version: user.version, reason: "Изменение собственных данных администратора",
      ...(b.password ? { password: b.password } : {}),
      current_password: b.current_password,
    }), "Данные для входа обновлены")}>
      <Field label="Номер телефона"><input name="phone" type="tel" autoComplete="tel" defaultValue={user.phone} required /></Field>
      <Field label="Новый пароль" hint="Не менее 10 символов. Оставьте пустым, чтобы сохранить текущий пароль."><input name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} /></Field>
      <Field label="Текущий пароль"><input name="current_password" type="password" autoComplete="current-password" maxLength={128} required /></Field>
      <p className="muted small">После смены пароля остальные сеансы будут завершены. Следующий вход — с новым телефоном и паролем.</p>
      <div className="modal-footer"><button className="btn" type="button" onClick={close}>Отмена</button><button className="btn primary" disabled={busy || offline}>Сохранить</button></div>
    </Form>;
  }
  if (modal.kind === "deleteEmployee" || modal.kind === "deleteType") {
    const isEmployee = modal.kind === "deleteEmployee";
    const item = isEmployee ? modal.employee : modal.type;
    title = isEmployee ? "Удалить сотрудника?" : "Удалить тип смены?";
    body = (
      <Form onSubmit={(b) => act(
        () => isEmployee ? api(`/employees/${modal.employee.id}`, "PATCH", {
          name: modal.employee.name, phone: modal.employee.phone,
          rate: modal.employee.rate, pay_type: modal.employee.pay_type,
          active: false, version: modal.employee.version, reason: b.reason,
        }) : api(`/shift-types/${modal.type.id}`, "PATCH", {
          name: modal.type.name, start_time: modal.type.start_time.slice(0, 5),
          end_time: modal.type.end_time.slice(0, 5), pay_type: modal.type.pay_type,
          rate: modal.type.rate, allow_exchange: modal.type.allow_exchange,
          active: false, version: modal.type.version,
        }),
        isEmployee ? "Сотрудник удалён из команды. Будущие смены отменены" : "Тип смены удалён",
      )}>
        <p><strong>{item.name}</strong> будет перемещён в архив.</p>
        <p className="muted small">{isEmployee
          ? "Доступ сотрудника будет закрыт. Текущая смена будет завершена в момент удаления, будущие отменятся, объявления на бирже закроются. История отработанных смен и начислений сохранится в графике и отчётах."
          : "Назначенные смены и их оплата сохранятся. Тип исчезнет из выбора для новых смен, а его открытые объявления на бирже будут закрыты."}</p>
        {isEmployee && <Field label="Причина удаления"><input name="reason" required minLength={3} maxLength={1000} placeholder="Например, сотрудник уволился" /></Field>}
        <div className="modal-footer">
          <button className="btn" type="button" onClick={close}>Отмена</button>
          <button className="btn primary" disabled={busy || offline}><Trash2 size={16} />{busy ? "Удаляем…" : isEmployee ? "Удалить сотрудника" : "Удалить тип смены"}</button>
        </div>
      </Form>
    );
  }
  if (modal.kind === "rate") {
    const employee = modal.employee;
    title = "Почасовая ставка";
    body = (
      <Form
        onSubmit={(b) =>
          act(
            () =>
              api(`/employees/${employee.id}/hourly-rate`, "PATCH", {
                rate: b.rate,
                version: employee.version,
                apply_to_future: b.apply_to_future === "on",
                reason: b.reason,
              }),
            "Почасовая ставка обновлена",
          )
        }
      >
        <div className="rate-employee">
          <Avatar name={employee.name} src={employee.avatar_url} />
          <div>
            <strong>{employee.name}</strong>
            <p className="muted">Индивидуальная ставка бариста</p>
          </div>
        </div>
        <Field
          label="Ставка в час, Br"
          hint="Ставка должна быть больше нуля. Например: 12,50 Br за час."
        >
          <input
            name="rate"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            defaultValue={
              employee.pay_type === "hourly" ? (employee.rate ?? "") : ""
            }
            placeholder="12.50"
            required
            autoFocus
          />
        </Field>
        <label className="checkbox-field">
          <input type="checkbox" name="apply_to_future" defaultChecked />
          Пересчитать будущие смены по ставке сотрудника
        </label>
        <p className="muted small">
          Применяется к новым сменам. При выбранном пересчёте обновятся также
          ещё не начавшиеся смены по ставке сотрудника; их открытые объявления будут
          закрыты. Прошедшие смены, фиксированные типы и ставки, заданные
          вручную в смене, сохраняются.
        </p>
        <Field label="Причина изменения">
          <input
            name="reason"
            required
            minLength={3}
            placeholder="Например, повышение ставки"
          />
        </Field>
        <div className="modal-footer">
          <button className="btn" type="button" onClick={close}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy || offline}>
            {busy ? "Сохраняем…" : "Сохранить ставку"}
          </button>
        </div>
      </Form>
    );
  }
  if (modal.kind === "employee") {
    const e = modal.employee;
    title = e ? "Профиль сотрудника" : "Добавить сотрудника";
    body = (
      <Form
        onSubmit={(b) =>
          act(
            () =>
              api(
                e ? `/employees/${e.id}` : "/employees",
                e ? "PATCH" : "POST",
                {
                  name: b.name,
                  phone: b.phone,
                  rate: b.rate || null,
                  pay_type: b.pay_type,
                  ...(e ? { apply_to_future: b.apply_to_future === "on" } : {}),
                  ...(e
                    ? {
                        active: b.active === "on",
                        version: e.version,
                        reason: b.reason,
                        ...(b.password ? { password: b.password } : {}),
                        ...(b.current_password ? { current_password: b.current_password } : {}),
                      }
                    : { password: b.password, role: b.role, ...(b.current_password ? { current_password: b.current_password } : {}) }),
                },
              ),
            e ? "Профиль сохранён" : "Сотрудник добавлен",
          )
        }
      >
        <Field label="Имя и фамилия">
          <input name="name" defaultValue={e?.name} required />
        </Field>
        <Field label="Телефон">
          <input
            name="phone"
            type="tel"
            defaultValue={e?.phone}
            readOnly={e?.role === "admin" && e.id !== user.id}
            placeholder="+375291234567"
            required
          />
        </Field>
        {!e && (
          <>
            <Field label="Роль">
              <select name="role" value={employeeRole} onChange={(event) => setEmployeeRole(event.target.value as "admin" | "barista")}>
                <option value="barista">Бариста</option>
                <option value="admin">Администратор</option>
              </select>
            </Field>
            <Field
              label="Временный пароль"
              hint="От 10 символов. Сотрудник сменит его при первом входе."
            >
              <input
                name="password"
                type="password"
                minLength={10}
                autoComplete="new-password"
                required
              />
            </Field>
          </>
        )}
        {e && (e.role !== "admin" || e.id === user.id) && <Field label="Новый пароль" hint={e.id === user.id ? "Оставьте пустым, чтобы не менять пароль." : "Оставьте пустым, чтобы не менять пароль. После сброса сотрудник задаст свой пароль при входе."}><input name="password" type="password" minLength={10} maxLength={128} autoComplete="new-password" /></Field>}
        {((!e && employeeRole === "admin") || (e && (e.role !== "admin" || e.id === user.id))) && <Field label="Текущий пароль администратора" hint="Обязателен при смене телефона, пароля или создании нового администратора."><input name="current_password" type="password" autoComplete="current-password" maxLength={128} required={!e && employeeRole === "admin"} /></Field>}
        {e?.role === "admin" && e.id !== user.id && <p className="muted small">Телефон и пароль другого администратора изменяет только владелец аккаунта в своём профиле.</p>}
        <div className="form-row">
          <Field label="Индивидуальная ставка, Br">
            <input
              name="rate"
              type="number"
              min="0.01"
              step=".01"
              defaultValue={e?.rate ?? ""}
              placeholder="Укажите ставку сотрудника"
            />
          </Field>
          <Field label="Оплата">
            <select name="pay_type" defaultValue={e?.pay_type ?? "hourly"}>
              <option value="hourly">За час</option>
              <option value="shift">За смену</option>
            </select>
          </Field>
        </div>
        {e && (
          <>
            <label className="checkbox-field"><input type="checkbox" name="apply_to_future" defaultChecked />Пересчитать будущие смены по ставке сотрудника</label>
            <p className="muted small">При изменении ставки или модели оплаты пересчитываются будущие смены по ставке сотрудника. Прошлые смены, фиксированные типы и ручные ставки сохраняются.</p>
            <label className="checkbox-field">
              <input type="checkbox" name="active" defaultChecked={e.active} />
              Сотрудник активен
            </label>
            <Field label="Причина изменения">
              <input name="reason" required minLength={3} />
            </Field>
            <p className="muted small">
              При отключении сотрудника текущая смена будет завершена в момент удаления, будущие отменятся. История отработанных смен сохранится.
            </p>
          </>
        )}
        <div className="modal-footer">
          <button className="btn" type="button" onClick={close}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy || offline}>
            Сохранить
          </button>
        </div>
      </Form>
    );
  }
  if (modal.kind === "type") {
    const t = modal.type;
    title = t ? "Настроить тип смены" : "Новый тип смены";
    body = (
      <Form
        onSubmit={(b) =>
          act(
            () =>
              api(
                t ? `/shift-types/${t.id}` : "/shift-types",
                t ? "PATCH" : "POST",
                {
                  name: b.name,
                  start_time: b.start_time,
                  end_time: b.end_time,
                  pay_type: b.pay_type,
                  ...(b.pay_type === "shift" ? { rate: b.rate } : {}),
                  active: b.active === "on",
                  allow_exchange: b.allow_exchange === "on",
                  ...(t ? { version: t.version } : {}),
                },
              ),
            "Тип смены сохранён",
          )
        }
      >
        <Field label="Название">
          <input
            name="name"
            defaultValue={t?.name}
            placeholder="Например, открытие"
            required
          />
        </Field>
        <div className="form-row">
          <Field label="Начало">
            <input
              type="time"
              name="start_time"
              defaultValue={t?.start_time.slice(0, 5) ?? "08:00"}
              required
            />
          </Field>
          <Field label="Окончание">
            <input
              type="time"
              name="end_time"
              defaultValue={t?.end_time.slice(0, 5) ?? "15:00"}
              required
            />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Модель оплаты">
            <select name="pay_type" value={typePayType} onChange={(event) => setTypePayType(event.target.value as "hourly" | "shift")}>
              <option value="hourly">По ставке сотрудника</option>
              <option value="shift">За смену</option>
            </select>
          </Field>
          {typePayType === "shift" && <Field label="Оплата за смену, Br">
            <input
              name="rate"
              type="number"
              min="0"
              step=".01"
              required
              defaultValue={t?.pay_type === "shift" ? t.rate : ""}
            />
          </Field>}
        </div>
        <label className="checkbox-field">
          <input
            type="checkbox"
            name="allow_exchange"
            defaultChecked={t?.allow_exchange ?? true}
          />
          Разрешить передачу через биржу
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            name="active"
            defaultChecked={t?.active ?? true}
          />
          Тип активен
        </label>
        <p className="muted small">
          {typePayType === "hourly" ? "Почасовая ставка задаётся у сотрудника в разделе «Команда». " : "Оплата за смену применяется к новым назначениям. "}Изменение типа не пересчитывает сохранённые смены.
        </p>
        <div className="modal-footer">
          <button className="btn" type="button" onClick={close}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy || offline}>
            Сохранить
          </button>
        </div>
      </Form>
    );
  }
  if (modal.kind === "take") {
    const l = modal.listing,
      q = modal.quote;
    title = "Забрать смену?";
    body = (
      <>
        <div className="quote-summary">
          <span className="tag red">{l.type_name}</span>
          <h3>{label(l.date)}</h3>
          <div className="listing-time">
            {l.start_time} — {l.end_time}
          </div>
          <p>
            {hours(q.minutes)} ч · {currency(q.rate)} /{" "}
            {q.pay_type === "hourly" ? "час" : "смену"}
          </p>
          <div className="quote-amount">
            <span>Ожидаемая оплата для вас</span>
            <strong>{currency(q.amount)}</strong>
          </div>
        </div>
        <p className="muted">
          Смена сразу появится в вашем графике. Подтверждение администратора не
          требуется. Повторно передать её через биржу будет нельзя.
        </p>
        {!canTakeExchangeAt(now) && <p className="info-strip">Забор смен доступен с 10:00 до 19:00 по Минску.</p>}
        <div className="modal-footer">
          <button className="btn" onClick={close}>
            Отмена
          </button>
          <button
            className="btn primary"
            disabled={busy || offline || !canTakeExchangeAt(now)}
            onClick={() =>
              act(
                () =>
                  api(
                    `/exchange/${l.id}/take`,
                    "POST",
                    { version: q.version },
                    modal.key,
                  ),
                "Смена теперь в вашем графике",
              )
            }
          >
            Подтвердить и забрать
          </button>
        </div>
      </>
    );
  }
  if (modal.kind === "reason") {
    title = modal.title;
    body = (
      <Form
        onSubmit={(b) =>
          act(() => modal.action(b.reason), "Действие выполнено")
        }
      >
        <Field label={title.includes("неделю") ? "Дата" : "Причина"}>
          <input
            name="reason"
            type={title.includes("неделю") ? "date" : "text"}
            required
            minLength={3}
          />
        </Field>
        <div className="modal-footer">
          <button className="btn" type="button" onClick={close}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy || offline}>
            Подтвердить
          </button>
        </div>
      </Form>
    );
  }
  if (modal.kind === "adjust") {
    title = "Корректировка часов и оплаты";
    body = (
      <Form
        onSubmit={(b) =>
          act(
            () =>
              api(`/shifts/${modal.shift.id}/adjustments`, "POST", {
                minutes: Number(b.minutes),
                amount: b.amount,
                reason: b.reason,
              }),
            "Корректировка сохранена",
          )
        }
      >
        <p>
          {modal.shift.user_name} · {label(modal.shift.date)}
        </p>
        <div className="form-row">
          <Field label="Изменение минут">
            <input
              name="minutes"
              type="number"
              step="1"
              min="-1440"
              max="1440"
              defaultValue="0"
              required
            />
          </Field>
          <Field label="Изменение суммы, Br">
            <input
              name="amount"
              type="number"
              step=".01"
              defaultValue="0.00"
              required
            />
          </Field>
        </div>
        <Field label="Причина">
          <textarea name="reason" minLength={3} required rows={3} />
        </Field>
        <p className="muted small">
          Положительное значение добавляет, отрицательное — вычитает. При
          почасовой оплате изменение минут также изменяет сумму.
        </p>
        <div className="modal-footer">
          <button className="btn" type="button" onClick={close}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy || offline}>
            Внести корректировку
          </button>
        </div>
      </Form>
    );
  }
  if (modal.kind === "message") {
    title = "Сообщение команде";
    body = (
      <Form
        onSubmit={(b) =>
          act(
            () =>
              api("/admin/notifications", "POST", {
                title: b.title,
                body: b.body,
                user_id: b.user_id || null,
              }),
            "Сообщение отправлено",
          )
        }
      >
        <Field label="Получатель">
          <select name="user_id">
            <option value="">Вся команда</option>
            {data.team.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Заголовок">
          <input name="title" required maxLength={200} />
        </Field>
        <Field label="Сообщение">
          <textarea name="body" required rows={4} maxLength={1000} />
        </Field>
        <div className="modal-footer">
          <button className="btn primary" disabled={busy || offline}>
            <Send size={16} />
            Отправить
          </button>
        </div>
      </Form>
    );
  }
  if (modal.kind === "publish") {
    title = "Выставить смену на биржу?";
    body = <><p>{label(modal.shift.date)} · {modal.shift.start_time}–{modal.shift.end_time} · {modal.shift.type_name}</p><p className="muted">Объявление станет доступно команде, сотрудники получат уведомления. Пока смену не забрали, она остаётся в вашем графике.</p><div className="modal-footer"><button className="btn" disabled={busy} onClick={close}>Отмена</button><button className="btn primary" disabled={busy || offline} onClick={() => act(() => api(`/shifts/${modal.shift.id}/exchange`, "POST"), "Смена выставлена на биржу")}>{busy ? "Публикуем…" : "Подтвердить публикацию"}</button></div></>;
  }
  if (modal.kind === "detail") {
    const raw = modal.shift,
      s =
        data.mine.find((m) => m.id === raw.id) ??
        data.shifts.find((m) => m.id === raw.id) ??
        raw;
    title = label(s.date, { day: "numeric", month: "long", weekday: "long" });
    const mine = s.user_id === user.id,
      canList =
        (mine || admin) &&
        s.user_id &&
        !s.exchanged &&
        !s.exchange_locked &&
        s.exchange_allowed &&
        !s.exchange_id &&
        new Date(s.closes_at) > now &&
        !["cancelled", "worked", "closed"].includes(s.status);
    body = (
      <>
        <div className="section-title">
          <span className={`tag ${s.exchange_id ? "red" : "neutral"}`}>
            {s.status === "cancelled" ? "Отменена" : !s.user_id ? "Не назначена" : s.exchange_id ? "На бирже" : statusLabels[s.status]}
          </span>
          <span className="muted">Минск · UTC+3</span>
        </div>
        <div className="detail-time">
          {s.start_time}
          <span>—</span>
          {s.end_time}
        </div>
        <h3>{s.type_name}</h3>
        <div className="detail-person">
          <Avatar name={s.user_name ?? "?"} src={data.team.find((person) => person.id === s.user_id)?.avatar_url} />
          <div>
            <strong>{s.user_name ?? "Не назначен"}</strong>
          </div>
        </div>
        {s.amount !== undefined && (
          <div className="detail-finance">
            <div>
              <span>Часы</span>
              <strong>
                {hours((s.minutes ?? 0) + (s.adjustment_minutes ?? 0))} ч
              </strong>
            </div>
            <div>
              <span>Ожидаемая оплата</span>
              <strong>{currency(s.amount)}</strong>
            </div>
          </div>
        )}
        {s.comment && <p className="detail-comment">{s.comment}</p>}
        {s.exchanged && (
          <p className="muted small">
            Смена уже передавалась. Повторная передача через биржу запрещена.
          </p>
        )}
        {(s.exchange_locked || !s.exchange_allowed) && (
          <p className="muted small">
            Передача этой смены через биржу отключена.
          </p>
        )}
        {(mine || admin) && new Date(s.closes_at) <= now && (
          <p className="muted small">
            Срок передачи истёк. Биржа работает с 10:00 до 19:00 по Минску.
          </p>
        )}
        {adjustments.length > 0 && (
          <div className="adjustment-history">
            <h4>Корректировки</h4>
            {adjustments.map((a) => (
              <div key={a.id}>
                <strong>
                  {a.minutes > 0 ? "+" : ""}
                  {a.minutes} мин · {currency(a.amount)}
                </strong>
                <p>{a.reason}</p>
                  <p className="muted small">Получатель: {a.user_name}</p>
                  {admin && a.credit_amount === null && a.minutes !== 0 && a.user_id !== s.user_id && <button className="btn tiny" onClick={() => setModal({ kind: "adjustmentCredit", adjustment: a })}>Уточнить сумму</button>}
                <small>
                  {a.author} · {stamp(a.created_at)}
                </small>
              </div>
            ))}
          </div>
        )}
        <div className="detail-actions">
          {canList && (
            <button
              className="btn primary full"
              disabled={busy || offline}
              onClick={() => setModal({ kind: "publish", shift: s })}
            >
              <ArrowLeftRight size={17} />
              Выставить на биржу
            </button>
          )}
          {s.exchange_id && (mine || admin) && (
            <button
              className="btn full"
              disabled={busy || offline}
              onClick={() =>
                act(
                  () => api(`/exchange/${s.exchange_id}/withdraw`, "POST"),
                  "Объявление отозвано",
                )
              }
            >
              Отозвать с биржи
            </button>
          )}
          {admin && (
            <>
              <button
                className="btn full"
                disabled={offline}
                onClick={() => setModal({ kind: "shift", shift: s })}
              >
                <SlidersHorizontal size={16} />
                Редактировать
              </button>
              {s.user_id && s.status !== "cancelled" && (
                <button
                  className="btn full"
                  onClick={() => setModal({ kind: "adjust", shift: s })}
                >
                  Корректировать часы и оплату
                </button>
              )}
              {s.status !== "cancelled" && (
                <button
                  className="text-link danger"
                  onClick={() =>
                    setModal({
                      kind: "reason",
                      title: "Причина отмены смены",
                      action: (reason) =>
                        api(`/shifts/${s.id}`, "DELETE", {
                          version: s.version,
                          reason,
                        }),
                    })
                  }
                >
                  Отменить смену
                </button>
              )}
            </>
          )}
        </div>
      </>
    );
  }
  return (
    <dialog
      ref={ref}
      className={`modal ${modal.kind === "shift" && !modal.shift ? "assignment-modal" : ""}`}
      aria-labelledby="modal-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="modal-inner" key={modal.kind}>
        <div className="modal-heading">
          <h2 id="modal-title">{title}</h2>
          <button
            className="icon-btn"
            aria-label="Закрыть диалог"
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {body}
      </div>
    </dialog>
  );
}
