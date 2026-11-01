import { randomUUID } from "node:crypto";
import { notificationText } from "./notification-text";
import type { Sql } from "./db";
import type { User, PayType } from "../shared/types";
import { exchangeDeadline } from "../shared/exchange-window";
export class Problem extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string, status = 422): never => {
  throw new Problem(status, code, message);
};
export const uid = randomUUID;
export const money = (value: unknown): string => {
  const s = String(value);
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s))
    fail(
      "INVALID_MONEY",
      "Укажите неотрицательную сумму с точностью до копейки",
    );
  return Number(s).toFixed(2);
};
export function phone(value: string): string {
  let p = value.replace(/[\s()\-]/g, "");
  if (/^80\d{9}$/.test(p)) p = "+375" + p.slice(2);
  if (/^375\d{9}$/.test(p)) p = "+" + p;
  if (!/^\+375\d{9}$/.test(p))
    fail(
      "INVALID_PHONE",
      "Введите белорусский телефон: +375291234567 или 80291234567",
    );
  return p;
}
export function dateTime(date: string, time: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  )
    fail("INVALID_DATE", "Проверьте дату и время");
  const d = new Date(`${date}T${time}:00+03:00`);
  if (
    !Number.isFinite(d.getTime()) ||
    new Date(d.getTime() + 10800000).toISOString().slice(0, 10) !== date
  )
    fail("INVALID_DATE", "Такой даты не существует");
  return d.toISOString();
}
export function period(from: string, to: string) {
  dateTime(from, "00:00");
  dateTime(to, "00:00");
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 0 || days > 93)
    fail("INVALID_PERIOD", "Выберите период не более 93 дней");
  return [from, to];
}
export function localDate(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Minsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function amount(
  minutes: number,
  rate: string,
  payType: PayType,
): string {
  const [whole, fraction = ""] = rate.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const total =
    payType === "shift" ? cents : (BigInt(minutes) * cents + 30n) / 60n;
  return `${total / 100n}.${String(total % 100n).padStart(2, "0")}`;
}
export const publicUser = (u: any): User => ({
  id: u.id,
  name: u.name,
  phone: u.phone,
  role: u.role,
  active: u.active,
  rate: u.rate,
  pay_type: u.pay_type,
  version: u.version,
  must_change_password: u.must_change_password,
  avatar_url: u.avatar_url ?? null,
});
export async function now(sql: Sql): Promise<Date> {
  return new Date((await sql.query("SELECT clock_timestamp() AS now"))[0].now);
}
export async function audit(
  sql: Sql,
  actor: string | null,
  action: string,
  entity: string,
  id: string | null,
  before: unknown = null,
  after: unknown = null,
  reason?: string,
) {
  await sql.query(
    "INSERT INTO audit_logs(id,actor_id,action,entity,entity_id,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      uid(),
      actor,
      action,
      entity,
      id,
      JSON.stringify(before),
      JSON.stringify(after),
      reason ?? null,
    ],
  );
  await sql.query("INSERT INTO events DEFAULT VALUES");
}
export async function notify(
  sql: Sql,
  users: (string | null)[],
  title: string,
  body: string,
  category = "schedule",
  link = "schedule",
  dedup?: string,
) {
  body = notificationText(body);
  for (const user of new Set(users.filter(Boolean))) {
    const id = uid();
    const result = await sql.query(
      "INSERT INTO notifications(id,user_id,title,body,category,link,dedup_key) SELECT $1,id,$3,$4,$5,$6,$7 FROM users WHERE id=$2 AND active ON CONFLICT(dedup_key) DO NOTHING RETURNING id",
      [
        id,
        user,
        title,
        body,
        category,
        link,
        dedup ? `${dedup}:${user}` : null,
      ],
    );
    if (result.length) {
      await sql.query("INSERT INTO events DEFAULT VALUES");
      await sql.query(
        "INSERT INTO deliveries(id,notification_id,device_id) SELECT gen_random_uuid(),$1,d.id FROM push_devices d LEFT JOIN preferences p ON p.user_id=d.user_id WHERE d.user_id=$2 AND COALESCE((to_jsonb(p)->>$3)::boolean,true) ON CONFLICT DO NOTHING",
        [id, user, category],
      );
    }
  }
}
export async function admins(sql: Sql): Promise<string[]> {
  return (
    await sql.query("SELECT id FROM users WHERE role='admin' AND active")
  ).map((u) => u.id);
}
export async function shiftForUpdate(sql: Sql, id: string) {
  const s = (
    await sql.query(
      "SELECT *, date::text AS date FROM shifts WHERE id=$1 FOR UPDATE",
      [id],
    )
  )[0];
  if (!s) fail("NOT_FOUND", "Смена не найдена", 404);
  return s;
}
export function expectVersion(row: any, version: number) {
  if (row.version !== version)
    fail(
      "STALE_VERSION",
      "Данные изменились. Обновите страницу и повторите действие",
      409,
    );
}
export async function assertExchange(sql: Sql, shift: any, time?: Date) {
  const t = time ?? (await now(sql));
  if (t >= new Date(shift.start_at))
    fail("SHIFT_STARTED", "Смена уже началась", 409);
  if (t >= exchangeDeadline(shift.start_at))
    fail(
      "EXCHANGE_DEADLINE_PASSED",
      "Срок передачи смены истёк. Биржа работает с 10:00 до 19:00 по Минску",
      409,
    );
  const type = (
    await sql.query("SELECT * FROM shift_types WHERE id=$1 FOR SHARE", [
      shift.type_id,
    ])
  )[0];
  await assertUnadjusted(sql, shift.id);
  if (
    shift.exchanged ||
    shift.exchange_locked ||
    !type?.active ||
    !type.allow_exchange ||
    ["cancelled", "worked", "closed"].includes(shift.status)
  )
    fail("EXCHANGE_FORBIDDEN", "Эту смену нельзя передать через биржу", 409);
  return type;
}
export async function assertUnadjusted(sql: Sql, shiftId: string) {
  if ((await sql.query("SELECT id FROM adjustments WHERE shift_id=$1 AND (minutes<>0 OR amount<>0) LIMIT 1", [shiftId])).length)
    fail("ADJUSTED_OWNER", "У смены есть персональные корректировки. Передача и откат владельца запрещены", 409);
}
export async function closeListing(sql: Sql, shiftId: string) {
  const listings = await sql.query(
    "UPDATE exchange_listings SET status='closed' WHERE shift_id=$1 AND status='open' RETURNING id,listed_by",
    [shiftId],
  );
  for (const listing of listings) {
    await notify(sql, [listing.listed_by], "Объявление закрыто", "Объявление автоматически закрыто из-за изменения смены или её типа. Проверьте назначение в графике.", "exchange", `shift:${shiftId}`);
    await audit(sql, null, "Объявление закрыто автоматически", "exchange", listing.id, null, { shift_id: shiftId });
  }
}
export function payTypeFor(type: any, user: any): PayType {
  return type.pay_type === "hourly" && user?.rate != null ? user.pay_type : type.pay_type;
}
export function positiveRate(value: string) {
  const rate = money(value);
  if (Number(rate) <= 0) fail("INVALID_RATE", "Ставка должна быть больше 0 Br");
  return rate;
}
export function rateFor(type: any, user: any, override?: string | null) {
  if (override != null) return money(override);
  if (type.pay_type === "hourly") {
    if (!user) return "0.00";
    if (user.rate == null)
      return fail("EMPLOYEE_RATE_REQUIRED", "Для расчёта оплаты не задана ставка сотрудника. Обратитесь к администратору");
    return positiveRate(user.rate);
  }
  return user?.rate != null && user.pay_type === "shift" ? user.rate : type.rate;
}
export const shiftProjection = `s.id, s.date::text, to_char(s.start_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS start_time, to_char(s.end_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS end_time, s.start_at, s.end_at, s.type_id, t.name AS type_name, s.user_id, u.name AS user_name, s.status, s.version, s.exchanged, s.exchange_locked, (t.allow_exchange AND t.active AND NOT EXISTS (SELECT 1 FROM adjustments ax WHERE ax.shift_id=s.id AND (ax.minutes<>0 OR ax.amount<>0))) AS exchange_allowed, l.id AS exchange_id, (CASE WHEN (s.start_at AT TIME ZONE 'Europe/Minsk')::time <= time '10:00' THEN s.date-1+time '19:00' ELSE LEAST(s.start_at AT TIME ZONE 'Europe/Minsk',s.date+time '19:00') END) AT TIME ZONE 'Europe/Minsk' AS closes_at`;
export const shiftJoins = `FROM shifts s JOIN shift_types t ON t.id=s.type_id LEFT JOIN users u ON u.id=s.user_id LEFT JOIN exchange_listings l ON l.shift_id=s.id AND l.status='open' AND l.closes_at>clock_timestamp()`;
export const financeProjection = `, (EXTRACT(EPOCH FROM (s.end_at-s.start_at))/60)::integer AS minutes, s.rate::text, s.pay_type, s.comment, COALESCE(a.minutes,0)::integer AS adjustment_minutes, COALESCE(a.amount,0)::text AS adjustment_amount, (CASE WHEN s.pay_type='shift' THEN s.rate ELSE round(((EXTRACT(EPOCH FROM(s.end_at-s.start_at))/60)+COALESCE(a.minutes,0))*s.rate/60,2) END + COALESCE(a.amount,0))::text AS amount`;
export const adjustmentJoin = `LEFT JOIN (SELECT shift_id,user_id,sum(minutes) AS minutes,sum(amount) AS amount FROM adjustments GROUP BY shift_id,user_id) a ON a.shift_id=s.id AND a.user_id=s.user_id`;
