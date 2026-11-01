import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  CalendarDays,
  Search,
} from "lucide-react";
import type { Shift } from "../shared/types";
import { Avatar, Empty } from "./App";
import {
  addDays,
  weekStart,
  monthGridRange,
  moveMonth,
  label,
} from "./dates";
type Props = {
  shifts: Shift[];
  mine: Shift[];
  team: { id: string; name: string; avatar_url?: string | null }[];
  anchor: string;
  setAnchor: (s: string) => void;
  today: string;
  admin: boolean;
  open: (s: Shift) => void;
  create: (date: string, userId?: string) => void;
  compact?: boolean;
};
export function Schedule({
  shifts,
  mine,
  team,
  anchor,
  setAnchor,
  today,
  admin,
  open,
  create,
  compact,
}: Props) {
  const [mode, setMode] = useState<"day" | "week" | "month">(() =>
      window.innerWidth <= 680 ? "day" : "week",
    ),
    [onlyMine, setOnlyMine] = useState(false),
    [search, setSearch] = useState("");
  const start = weekStart(anchor),
    days = Array.from({ length: 7 }, (_, i) => addDays(start, i)),
    mineIds = new Set(mine.map((s) => s.id));
  const source = (
    onlyMine ? shifts.filter((s) => mineIds.has(s.id)) : shifts
  ).filter((s) => s.status !== "cancelled");
  const staffById = new Map<string, { id: string; name: string; avatar_url?: string | null; archived?: boolean }>(team.map((user) => [user.id, user]));
  for (const shift of source) {
    if (shift.user_id && !staffById.has(shift.user_id)) staffById.set(shift.user_id, { id: shift.user_id, name: shift.user_name ?? "Сотрудник в архиве", avatar_url: shift.user_avatar_url, archived: true });
  }
  const staff = [...staffById.values()].filter(
    (u) =>
      (!onlyMine || mine.some((s) => s.user_id === u.id)) &&
      u.name.toLowerCase().includes(search.toLowerCase()),
  );
  const visibleDays = mode === "day" ? [anchor] : days;
  const [monthFrom, monthTo] = monthGridRange(anchor),
    monthDays = Array.from({ length: Math.round((Date.parse(monthTo) - Date.parse(monthFrom)) / 86400000) + 1 }, (_, index) => addDays(monthFrom, index));
  const dateTitle =
    mode === "month"
      ? label(anchor, { month: "long", year: "numeric" })
      : mode === "day"
        ? label(anchor, { day: "numeric", month: "long", year: "numeric" })
        : `${label(start)} — ${label(days[6], { day: "numeric", month: "long", year: "numeric" })}`;
  function move(n: number) {
    setAnchor(
      mode === "month"
        ? moveMonth(anchor, n)
        : addDays(anchor, n * (mode === "week" ? 7 : 1)),
    );
  }
  function chip(s: Shift) {
    return (
      <button
        key={s.id}
        aria-label={`${s.user_name ?? "Не назначена"}, ${s.start_time}–${s.end_time}, ${s.type_name}`}
        onClick={() => open(s)}
        className={`shift-chip ${s.exchange_id ? "exchange" : s.type_name.toLowerCase().includes("закрыт") ? "closing" : ""}`}
      >
        <span className="chip-time">
          {s.start_time} – {s.end_time}
        </span>
        <span className="chip-type">
          {s.type_name}
          {s.exchange_id && <i />}
        </span>
        {mode === "month" && <span className="chip-owner"><Avatar name={s.user_name ?? "Не назначена"} src={s.user_avatar_url} small /><span>{s.user_name ?? "Не назначена"}</span></span>}
      </button>
    );
  }
  return (
    <section className="panel schedule-panel">
      <div className="schedule-heading">
        <div className="section-title">
          <h2>
            {compact ? "График команды" : "Расписание"}
            {compact && <span className="count-label">Неделя</span>}
          </h2>
          <div className="segmented">
            {(["day", "week", "month"] as const).map((m) => (
              <button
                key={m}
                className={mode === m ? "active" : ""}
                onClick={() => setMode(m)}
              >
                {m === "day" ? "День" : m === "week" ? "Неделя" : "Месяц"}
              </button>
            ))}
          </div>
        </div>
        <div className="schedule-toolbar">
          <div className="calendar-controls">
            <button
              className="icon-btn"
              aria-label="Предыдущий период"
              onClick={() => move(-1)}
            >
              <ChevronLeft size={18} />
            </button>
            <strong>{dateTitle}</strong>
            <button
              className="icon-btn"
              aria-label="Следующий период"
              onClick={() => move(1)}
            >
              <ChevronRight size={18} />
            </button>
            <button className="btn tiny" onClick={() => setAnchor(today)}>
              Сегодня
            </button>
          </div>
          <div className="inline-actions">
            {!admin && (
              <button
                className={`btn tiny ${onlyMine ? "selected" : ""}`}
                onClick={() => setOnlyMine(!onlyMine)}
              >
                {onlyMine ? "Мои смены" : "Вся команда"}
              </button>
            )}
            <label className="search-input">
              <Search size={15} />
              <input
                aria-label="Поиск сотрудника"
                placeholder="Сотрудник"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
        </div>
      </div>
      {mode === "month" ? (
        <div className="month-calendar" aria-label={dateTitle}>
          <div className="month-weekdays">
            {["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"].map((day, index) => (
              <span key={day}><abbr title={day}>{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"][index]}</abbr></span>
            ))}
          </div>
          <div className="month-grid">
            {monthDays.map((day, index) => {
              const outside = day.slice(0, 7) !== anchor.slice(0, 7);
              const dayShifts = source.filter((shift) => shift.date === day && (!search || shift.user_name?.toLowerCase().includes(search.toLowerCase())));
              const openDay = () => { setAnchor(day); setMode("day"); };
              return (
              <div
                key={day}
                data-date={day}
                className={`month-cell ${outside ? "adjacent-month" : "current-month"} ${day === today ? "is-today" : ""}`}
              >
                <div className="month-date-header">
                <button
                  className="month-day"
                  aria-label={label(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                  aria-current={day === today ? "date" : undefined}
                  onClick={openDay}
                >
                  <span className="month-day-number">{Number(day.slice(-2))}</span>
                  {(index === 0 || day.endsWith("-01")) && <span className="month-day-month">{label(day, { month: "short" })}</span>}
                </button>
                {admin && !outside && (
                  <button className="month-add" aria-label={`Добавить смену ${label(day)}`} onClick={() => create(day)}><Plus size={15} /></button>
                )}
                </div>
                <div className="month-events">
                {dayShifts.slice(0, 2).map(chip)}
                {dayShifts.length > 2 && (
                  <button
                    className="month-more"
                    aria-label={`Ещё ${dayShifts.length - 2} смены, ${label(day)}`}
                    onClick={openDay}
                  >
                    Ещё {dayShifts.length - 2}
                  </button>
                )}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="table-scroll schedule-scroll">
          <table
            className={`schedule-table ${mode === "day" ? "day-view" : ""}`}
          >
            <thead>
              <tr>
                <th className="person-heading">
                  СОТРУДНИК <span>{staff.length}</span>
                </th>
                {visibleDays.map((day) => (
                  <th key={day} className={day === today ? "current-day" : ""}>
                    <span>
                      {label(day, { weekday: "short" }).toUpperCase()}
                    </span>
                    <strong>
                      {Number(day.slice(-2))}
                      {day === today && <i />}
                    </strong>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {staff.map((u) => (
                <tr key={u.id}>
                  <th className="person-cell">
                    <Avatar name={u.name} src={u.avatar_url} />
                    <span>
                      <strong>{u.name}</strong>
                      <small>
                        {u.archived && "В архиве · "}
                        {
                          source.filter(
                            (s) =>
                              s.user_id === u.id &&
                              visibleDays.includes(s.date),
                          ).length
                        }{" "}
                        смен на период
                      </small>
                    </span>
                  </th>
                  {visibleDays.map((day) => (
                    <td
                      key={day}
                      className={day === today ? "current-day" : ""}
                    >
                      {source
                        .filter((s) => s.user_id === u.id && s.date === day)
                        .map(chip)}
                      {admin && !u.archived &&
                        !source.some(
                          (s) => s.user_id === u.id && s.date === day,
                        ) && (
                          <button
                            className="add-cell"
                            aria-label={`Добавить смену: ${u.name}, ${label(day)}`}
                            onClick={() => create(day, u.id)}
                          >
                            <Plus size={16} />
                          </button>
                        )}
                    </td>
                  ))}
                </tr>
              ))}
              {source.some(
                (s) => !s.user_id && visibleDays.includes(s.date),
              ) && (
                <tr>
                  <th className="person-cell">
                    <span className="vacant-icon">?</span>
                    <span>
                      <strong>Не назначены</strong>
                      <small>Нужен сотрудник</small>
                    </span>
                  </th>
                  {visibleDays.map((day) => (
                    <td key={day}>
                      {source
                        .filter((s) => !s.user_id && s.date === day)
                        .map(chip)}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
          {!staff.length && (
            <Empty
              icon={CalendarDays}
              title="Пока никого нет в графике"
              text="Добавьте сотрудников или измените фильтр."
            />
          )}
        </div>
      )}
      <div className="calendar-legend">
        <span>
          <i className="legend-light" />
          Открытие / другие
        </span>
        <span>
          <i className="legend-dark" />
          Закрытие
        </span>
        <span>
          <i className="legend-red" />
          На бирже
        </span>
        <span className="calendar-zone">Время — Минск, UTC+3</span>
      </div>
    </section>
  );
}
