import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Sql } from "./db";
import { Problem } from "./domain";

export function trustedProxies(value = process.env.TRUSTED_PROXIES) {
  if (!value?.trim()) return false;
  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const [address, bits, extra] = entry.split("/");
    const family = isIP(address);
    if (!family || extra !== undefined || (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > (family === 4 ? 32 : 128)))) {
      throw new Error("TRUSTED_PROXIES must contain explicit proxy IP addresses or CIDRs; trusting every address is forbidden");
    }
  }
  return entries;
}
export const budgetKey = (scope: string, identity: string) => `${scope}:${createHash("sha256").update(identity).digest("hex")}`;
function limited(retryAfter: number) {
  return Object.assign(new Problem(429, "RATE_LIMITED", "Слишком много попыток. Попробуйте позже"), { retryAfter });
}
export async function consumeBudget(sql: Sql, key: string, max: number, windowMs: number) {
  const row = (await sql.query(
    "INSERT INTO request_limits(key,hits,resets_at) VALUES($1,1,clock_timestamp()+($2::text||' milliseconds')::interval) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN request_limits.resets_at<=clock_timestamp() THEN 1 ELSE LEAST(request_limits.hits+1,1000000) END,resets_at=CASE WHEN request_limits.resets_at<=clock_timestamp() THEN clock_timestamp()+($2::text||' milliseconds')::interval ELSE request_limits.resets_at END RETURNING hits,GREATEST(1,ceil(EXTRACT(EPOCH FROM(resets_at-clock_timestamp()))))::integer AS retry_after",
    [key, windowMs],
  ))[0];
  if (row.hits > max) throw limited(row.retry_after);
}
export class MemoryBudget {
  private entries = new Map<string, { hits: number; until: number }>();
  consume(key: string, max: number, windowMs: number) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) entry = { hits: 0, until: now + windowMs };
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > 10000) this.entries.delete(this.entries.keys().next().value!);
    if (++entry.hits > max) throw limited(Math.max(1, Math.ceil((entry.until - now) / 1000)));
  }
}
export class ResourceGate {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private capacity: number, private maxQueued = 0) {}
  enter() {
    if (this.active >= this.capacity) throw new Problem(503, "SERVER_BUSY", "Сервер занят. Повторите через несколько секунд");
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; this.waiters.shift()?.(); } };
  }
  async run<T>(operation: () => Promise<T>) {
    const release = this.active < this.capacity ? this.enter() : await new Promise<() => void>((resolve, reject) => {
      if (this.waiters.length >= this.maxQueued) { reject(new Problem(503, "SERVER_BUSY", "Сервер занят. Повторите через несколько секунд")); return; }
      this.waiters.push(() => resolve(this.enter()));
    });
    try { return await operation(); } finally { release(); }
  }
}
