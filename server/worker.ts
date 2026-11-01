import { firebasePush, invalidPushToken, platformPushReady, type PushGateway } from "./push";
import type { Database } from "./db";
import { audit, notify, admins, uid } from "./domain";
export async function tick(db: Database, push: PushGateway = firebasePush) {
  await db.tx(async (sql) => {
    await sql.query("DELETE FROM sessions WHERE expires_at<=clock_timestamp()");
    await sql.query("DELETE FROM request_limits WHERE resets_at<clock_timestamp()-interval '1 day'");
    // These administrative edits are audit-only. Do not send old queued
    // notifications when push is enabled for the first time.
    await sql.query("DELETE FROM deliveries d USING notifications n WHERE d.notification_id=n.id AND d.sent_at IS NULL AND n.category='admin' AND n.link IN ('employees','types') AND n.title IN ('Новый сотрудник','Команда обновлена','Типы смен обновлены')");
    const finished = await sql.query(
      "UPDATE shifts SET status='worked',version=version+1 WHERE status IN ('planned','confirmed') AND end_at<=clock_timestamp() RETURNING id,user_id,date::text",
    );
    for (const s of finished)
      await audit(
        sql,
        null,
        "Смена завершена по расписанию",
        "shift",
        s.id,
        null,
        { status: "worked" },
      );
    const expired = await sql.query(
      "UPDATE exchange_listings SET status='expired' WHERE status='open' AND closes_at<=clock_timestamp() RETURNING id,listed_by,shift_id",
    );
    for (const l of expired) {
      await notify(
        sql,
        [l.listed_by, ...(await admins(sql))],
        "Биржа закрыта",
        "Объявление истекло. Назначение смены сохраняется",
        "exchange",
        `shift:${l.shift_id}`,
        `expired:${l.id}`,
      );
      await audit(sql, null, "Срок объявления истёк", "exchange", l.id);
    }
    const reminders = await sql.query(
      "SELECT s.id,s.user_id,s.version,s.date::text,to_char(s.start_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS start_time,EXTRACT(EPOCH FROM(s.start_at-clock_timestamp()))/60 AS remaining,COALESCE(p.reminder_120,true) AS r120,COALESCE(p.reminder_60,false) AS r60 FROM shifts s JOIN users u ON u.id=s.user_id AND u.active LEFT JOIN preferences p ON p.user_id=s.user_id WHERE s.status IN ('planned','confirmed') AND s.start_at>clock_timestamp() AND s.start_at<=clock_timestamp()+interval '120 minutes'",
    );
    for (const s of reminders)
      for (const m of [120, 60])
        if (
          (m === 120 ? s.r120 : s.r60) &&
          Number(s.remaining) <= m &&
          Number(s.remaining) > m - 1
        )
          await notify(
            sql,
            [s.user_id],
            `Смена через ${m === 120 ? "2 часа" : "1 час"}`,
            `${s.date} · Начало в ${s.start_time}`,
            "schedule",
            `shift:${s.id}`,
            `reminder:${s.id}:${s.version}:${m}`,
          );
    const warnings = await sql.query(
      "SELECT l.id,l.listed_by,l.shift_id FROM exchange_listings l WHERE l.status='open' AND l.closes_at>clock_timestamp()+interval '29 minutes' AND l.closes_at<=clock_timestamp()+interval '30 minutes'",
    );
    for (const l of warnings)
      await notify(
        sql,
        [l.listed_by],
        "Биржа скоро закроется",
        "До начала смены или дедлайна 19:00 осталось 30 минут",
        "exchange",
        `shift:${l.shift_id}`,
        `warning:${l.id}`,
      );
    const uncovered = await sql.query(
      "SELECT id,date::text FROM shifts WHERE user_id IS NULL AND status<>'cancelled' AND start_at<=clock_timestamp() AND end_at>clock_timestamp()",
    );
    for (const s of uncovered)
      await notify(
        sql,
        await admins(sql),
        "Смена без сотрудника",
        `${s.date} · Назначьте ответственного`,
        "admin",
        `shift:${s.id}`,
        `uncovered:${s.id}`,
      );
  });
  const pushSettings = await push.settings();
  if (!pushSettings.ready) return;
  // One API process owns delivery in the initial deployment. DB events remain durable.
  const deliveries = await db.query(
    "SELECT d.id,d.device_id,d.attempts,p.token,p.platform,n.id AS notification_id,n.title,n.body,n.link,n.dedup_key,n.user_id FROM deliveries d JOIN notifications n ON n.id=d.notification_id JOIN push_devices p ON p.id=d.device_id AND p.user_id=n.user_id JOIN sessions sess ON sess.id=p.session_id AND sess.user_id=p.user_id AND sess.expires_at>clock_timestamp() JOIN users u ON u.id=n.user_id AND u.active LEFT JOIN preferences pref ON pref.user_id=n.user_id WHERE ((p.platform='android' AND $1::boolean) OR (p.platform='web' AND $2::boolean)) AND d.sent_at IS NULL AND d.attempts<8 AND d.next_attempt<=clock_timestamp() AND COALESCE((to_jsonb(pref)->>n.category)::boolean,true) ORDER BY d.next_attempt LIMIT 20",
    [platformPushReady(pushSettings, "android"), platformPushReady(pushSettings, "web")],
  );
  for (const d of deliveries) {
    if (!platformPushReady(pushSettings, d.platform)) continue;
    if (!(await db.query("SELECT 1 FROM push_devices p JOIN sessions s ON s.id=p.session_id AND s.user_id=p.user_id JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND p.user_id=$2 AND s.expires_at>clock_timestamp() AND u.active", [d.device_id, d.user_id])).length) continue;
    if (d.dedup_key?.startsWith("reminder:")) {
      const [, id, version, interval] = d.dedup_key.split(":");
      const current = (
        await db.query(
          "SELECT 1 FROM shifts s LEFT JOIN preferences p ON p.user_id=s.user_id WHERE s.id=$1 AND s.version=$2 AND s.user_id=$3 AND s.status IN ('planned','confirmed') AND s.start_at>clock_timestamp() AND COALESCE((to_jsonb(p)->>$4)::boolean,$5)",
          [
            id,
            Number(version),
            d.user_id,
            `reminder_${interval}`,
            interval === "120",
          ],
        )
      ).length;
      if (!current) {
        await db.query(
          "UPDATE deliveries SET attempts=8,last_error='stale_reminder' WHERE id=$1",
          [d.id],
        );
        continue;
      }
    }
    try {
      await push.send({
        token: d.token,
        platform: d.platform,
        title: d.title,
        body: d.body,
        link: d.link,
        id: d.notification_id,
      });
      await db.query(
        "UPDATE deliveries SET sent_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1",
        [d.id],
      );
    } catch (e: any) {
      if (invalidPushToken(e))
        await db.query("DELETE FROM push_devices WHERE token=$1", [d.token]);
      else
        await db.query(
          "UPDATE deliveries SET attempts=attempts+1,last_error=$2,next_attempt=clock_timestamp()+($3::text||' seconds')::interval WHERE id=$1",
          [
            d.id,
            e.code ?? "delivery_error",
            Math.min(3600, 2 ** (d.attempts + 1) * 15),
          ],
        );
    }
  }
}
export function startWorker(db: Database, onError: (e: unknown) => void) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(db);
    } catch (e) {
      onError(e);
    } finally {
      busy = false;
    }
  }, 15000);
  return () => clearInterval(timer);
}
