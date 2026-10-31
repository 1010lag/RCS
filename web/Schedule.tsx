import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Copy,
  CalendarDays,
  Search,
} from "lucide-react";
import type { Shift } from "../shared/types";
import { Avatar, Empty } from "./App";
import {
  addDays,
  weekStart,
  monthStart,
  monthEnd,
  moveMonth,
  label,
  hours,
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
  repeat?: (from: string) => void;
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
  repeat,
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
  const staff = team.filter(
    (u) =>
      (!onlyMine || mine.some((s) => s.user_id === u.id)) &&
      u.name.toLowerCase().includes(search.toLowerCase()),
  );
  const visibleDays = mode === "day" ? [anchor] : days;
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
            {repeat && admin && (
              <button className="btn tiny" onClick={() => repeat(start)}>
                <Copy size={14} />
                Повторить неделю
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
        <>
          <div className="month-weekdays">
            {["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"].map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div className="month-grid">
            {Array.from({ length: 42 }, (_, i) =>
              addDays(weekStart(monthStart(anchor)), i),
            ).map((day) => (
              <div
                key={day}
                className={`month-cell ${day.slice(0, 7) !== anchor.slice(0, 7) ? "outside" : ""} ${day === today ? "is-today" : ""}`}
              >
                <button
                  className="month-day"
                  onClick={() => {
                    setAnchor(day);
                    setMode("day");
                  }}
                >
                  {Number(day.slice(-2))}
                </button>
                {source
                  .filter(
                    (s) =>
                      s.date === day &&
                      (!search ||
                        s.user_name
                          ?.toLowerCase()
                          .includes(search.toLowerCase())),
                  )
                  .slice(0, 4)
                  .map(chip)}
                {source.filter((s) => s.date === day).length > 4 && (
                  <button
                    className="text-link small"
                    onClick={() => {
                      setAnchor(day);
                      setMode("day");
                    }}
                  >
                    Все смены →
                  </button>
                )}
                {admin && (
                  <button
                    className="month-add"
                    aria-label={`Добавить смену ${label(day)}`}
                    onClick={() => create(day)}
                  >
                    <Plus size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
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
                      {admin &&
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
