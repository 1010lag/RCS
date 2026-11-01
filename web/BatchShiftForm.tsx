import { useRef, useState } from "react";
import { Clock, Plus, Trash2 } from "lucide-react";
import type { ShiftType } from "../shared/types";
import { Field, Form } from "./App";
import { api } from "./api";

type Assignment = { id: string; userId: string; typeId: string };
export function BatchShiftForm({ date, userId, types, team, busy, offline, close, act, onAssigned }: {
  date: string; userId?: string; types: ShiftType[];
  team: { id: string; name: string }[]; busy: boolean; offline: boolean;
  close: () => void; act: (fn: () => Promise<any>, message?: string) => Promise<any>;
  onAssigned: (date: string) => void;
}) {
  const activeTypes = types.filter((type) => type.active);
  const [rows, setRows] = useState<Assignment[]>(() => [{ id: crypto.randomUUID(), userId: userId ?? "", typeId: activeTypes[0]?.id ?? "" }]);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const update = (id: string, values: Partial<Assignment>) => setRows((items) => items.map((row) => row.id === id ? { ...row, ...values } : row));
  return <Form onSubmit={(fields) => act(async () => {
    const payload = {
      date: fields.date,
      assignments: rows.map((row) => ({ user_id: row.userId === "unassigned" ? null : row.userId, type_id: row.typeId, type_version: activeTypes.find((type) => type.id === row.typeId)?.version ?? 0 })),
      status: fields.status, comment: fields.comment,
      exchange_locked: fields.exchange_locked === "on",
    };
    const serialized = JSON.stringify(payload);
    if (attempt.current?.payload !== serialized) attempt.current = { payload: serialized, key: crypto.randomUUID() };
    await api("/shifts/batch", "POST", payload, attempt.current.key);
    onAssigned(fields.date);
  }, rows.length === 1 ? "Смена сохранена" : "Смены назначены")}>
    <Field label="Дата"><input type="date" name="date" defaultValue={date} required disabled={busy} /></Field>
    <p className="muted small">Выберите сотрудников и распределите типы смен. Время и оплата подставятся автоматически.</p>
    <div className="assignment-list">
      {rows.map((row, index) => {
        const type = activeTypes.find((type) => type.id === row.typeId);
        return <fieldset className="assignment-row" data-testid="assignment-row" key={row.id} disabled={busy}>
          <legend>Назначение {index + 1}</legend>
          {rows.length > 1 && <button type="button" className="icon-btn assignment-remove" aria-label={`Убрать назначение ${index + 1}`} onClick={() => setRows((items) => items.filter((item) => item.id !== row.id))}><Trash2 size={17} /></button>}
          <div className="form-row">
            <Field label="Сотрудник"><select name={index === 0 ? "user_id" : `user_id_${row.id}`} value={row.userId} onChange={(event) => update(row.id, { userId: event.target.value })} required>
              <option value="" disabled>Выберите сотрудника</option>
              {team.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              <option value="unassigned">Без сотрудника</option>
            </select></Field>
            <Field label="Тип смены"><select name={index === 0 ? "type_id" : `type_id_${row.id}`} value={row.typeId} onChange={(event) => update(row.id, { typeId: event.target.value })} required>
              <option value="" disabled>Выберите тип</option>
              {activeTypes.map((type) => <option key={type.id} value={type.id}>{type.name} · {type.start_time.slice(0, 5)}–{type.end_time.slice(0, 5)}</option>)}
            </select></Field>
          </div>
          {type && <p className="assignment-time"><Clock size={15} aria-hidden="true" />{type.start_time.slice(0, 5)}–{type.end_time.slice(0, 5)}<span>Время по типу смены</span></p>}
        </fieldset>;
      })}
    </div>
    <button type="button" className="btn full" disabled={busy || rows.length >= 50} onClick={() => setRows((items) => [...items, { id: crypto.randomUUID(), userId: "", typeId: activeTypes[0]?.id ?? "" }])}><Plus size={16} />Добавить ещё сотрудника</button>
    <details className="assignment-options">
      <summary>Дополнительно</summary>
      <Field label="Статус"><select name="status" defaultValue="confirmed" disabled={busy}><option value="confirmed">Подтверждена</option><option value="planned">Запланирована</option></select></Field>
      <Field label="Комментарий"><textarea name="comment" maxLength={1000} rows={2} disabled={busy} /></Field>
      <label className="checkbox-field"><input name="exchange_locked" type="checkbox" disabled={busy} />Запретить передачу через биржу</label>
    </details>
    {!activeTypes.length && <p className="error">Сначала создайте активный тип смены.</p>}
    <div className="modal-footer"><button type="button" className="btn" onClick={close} disabled={busy}>Отмена</button><button className="btn primary" disabled={busy || offline || !activeTypes.length}>{busy ? "Сохраняем…" : rows.length === 1 ? "Сохранить смену" : `Назначить смены · ${rows.length}`}</button></div>
  </Form>;
}
