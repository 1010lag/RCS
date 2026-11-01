import type { Database } from "./db";
import { adjustmentJoin, fail } from "./domain";

export async function payrollRows(db: Database, from: string, to: string, user?: string, asOf = new Date()) {
  const filterParams = user ? [from, to, user] : [from, to];
  const params = user ? [from, to, asOf, user] : [from, to, asOf];
  const unresolved = await db.query(
    `SELECT a.id FROM adjustments a JOIN shifts s ON s.id=a.shift_id WHERE s.date BETWEEN $1 AND $2 AND s.status<>'cancelled' AND a.user_id IS DISTINCT FROM s.user_id AND a.credit_amount IS NULL AND a.minutes<>0 ${user ? "AND a.user_id=$3" : ""} LIMIT 1`, filterParams,
  );
  if (unresolved.length) fail("ADJUSTMENT_REVIEW_REQUIRED", "Старая корректировка часов требует проверки суммы администратором. Начисления не будут перенесены другому сотруднику", 409);
  return db.query(
    `WITH owned AS (
      SELECT s.user_id,u.name,s.date,(EXTRACT(EPOCH FROM(s.end_at-s.start_at))/60+COALESCE(a.minutes,0))::integer AS minutes,
      CASE WHEN s.pay_type='shift' THEN s.rate ELSE round((EXTRACT(EPOCH FROM(s.end_at-s.start_at))/60+COALESCE(a.minutes,0))*s.rate/60,2) END+COALESCE(a.amount,0) AS amount,
      (s.end_at<=$3 OR s.status IN ('worked','closed')) AS worked
      FROM shifts s JOIN users u ON u.id=s.user_id ${adjustmentJoin} WHERE s.date BETWEEN $1 AND $2 AND s.status<>'cancelled' ${user ? "AND s.user_id=$4" : ""}
    ), personal AS (
      SELECT a.user_id,u.name,s.date,sum(a.minutes)::integer AS minutes,sum(COALESCE(a.credit_amount,a.amount)) AS amount,
      (s.end_at<=$3 OR s.status IN ('worked','closed')) AS worked
      FROM adjustments a JOIN shifts s ON s.id=a.shift_id JOIN users u ON u.id=a.user_id
      WHERE s.date BETWEEN $1 AND $2 AND s.status<>'cancelled' AND a.user_id IS DISTINCT FROM s.user_id ${user ? "AND a.user_id=$4" : ""}
      GROUP BY a.user_id,u.name,s.id,s.date,s.end_at,s.status
    ), totals AS (SELECT * FROM owned UNION ALL SELECT * FROM personal)
    SELECT user_id,name,date::text,COALESCE(sum(minutes) FILTER(WHERE worked),0)::integer AS minutes,
    COALESCE(sum(amount) FILTER(WHERE worked),0)::text AS amount,COALESCE(sum(minutes) FILTER(WHERE NOT worked),0)::integer AS planned_minutes,
    COALESCE(sum(amount) FILTER(WHERE NOT worked),0)::text AS planned_amount FROM totals GROUP BY user_id,name,date ORDER BY date DESC,name`, params,
  );
}
