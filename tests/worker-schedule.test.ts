import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../server/db";
import { nextWorkerDelay } from "../server/worker";
import type { PushGateway } from "../server/push";
import { uid, localDate, dateTime } from "../server/domain";
import { createApp } from "../server/app";
import { hash } from "@node-rs/argon2";

describe("Cloud worker deadlines", () => {
  let db: Database, user: string, shift: string;
  const idle = 3600000;
  const disabled: PushGateway = {
    settings: async () => ({ ready: false, status: "unconfigured", issues: [], config: null, vapidKey: null, origin: null }),
    send: async () => "unused",
  };
  beforeAll(async () => { db = await openDatabase(":memory:"); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.query("TRUNCATE users,shift_types CASCADE");
    user = uid(); shift = uid();
    const type = uid();
    const day = new Date(Date.parse(localDate()) + 86400000).toISOString().slice(0, 10);
    await db.query("INSERT INTO users(id,name,phone,password_hash,role) VALUES($1,'Fixture','+375291234567','unused','admin')", [user]);
    await db.query("INSERT INTO shift_types(id,name,start_time,end_time,pay_type,rate) VALUES($1,'Fixture','12:00','13:00','hourly',10)", [type]);
    await db.query("INSERT INTO shifts(id,date,start_at,end_at,type_id,user_id,pay_type,rate) VALUES($1,$2,$3,$4,$5,$6,'hourly',10)", [shift, day, dateTime(day, "12:00"), dateTime(day, "13:00"), type, user]);
  });
  it("allows an idle database to suspend instead of polling every 15 seconds", async () => {
    expect(await nextWorkerDelay(db, idle, disabled)).toBe(idle);
  });
  it("wakes for an exchange deadline within the idle period", async () => {
    await db.query("INSERT INTO exchange_listings(id,shift_id,listed_by,closes_at) VALUES($1,$2,$3,clock_timestamp()+interval '60 seconds')", [uid(), shift, user]);
    const delay = await nextWorkerDelay(db, idle, disabled);
    expect(delay).toBeGreaterThan(55000);
    expect(delay).toBeLessThanOrEqual(60000);
  });
  it("wakes for the 30-minute exchange warning before the closing deadline", async () => {
    await db.query("INSERT INTO exchange_listings(id,shift_id,listed_by,closes_at) VALUES($1,$2,$3,clock_timestamp()+interval '31 minutes')", [uid(), shift, user]);
    const delay = await nextWorkerDelay(db, idle, disabled);
    expect(delay).toBeGreaterThan(55000);
    expect(delay).toBeLessThanOrEqual(60000);
  });
  it("plans enabled shift reminders before shift completion", async () => {
    const start = (await db.query("SELECT start_at::text AS start FROM shifts WHERE id=$1", [shift]))[0].start;
    const expected = Date.parse(start) - 120 * 60000 - Date.now();
    expect(Math.abs(await nextWorkerDelay(db, 172800000, disabled) - expected)).toBeLessThan(1000);
    await db.query("INSERT INTO preferences(user_id,reminder_120,reminder_60) VALUES($1,false,true)", [user]);
    const expected60 = Date.parse(start) - 60 * 60000 - Date.now();
    expect(Math.abs(await nextWorkerDelay(db, 172800000, disabled) - expected60)).toBeLessThan(1000);
  });
  it("immediately resumes a due push delivery only when that platform is configured", async () => {
    const device = uid(), notification = uid();
    await db.query("INSERT INTO sessions VALUES('session',$1,'csrf',clock_timestamp()+interval '1 day')", [user]);
    await db.query("INSERT INTO push_devices(id,user_id,token,platform,session_id) VALUES($1,$2,'token','android','session')", [device, user]);
    await db.query("INSERT INTO notifications(id,user_id,title,body,category,link) VALUES($1,$2,'Title','Body','schedule','schedule')", [notification, user]);
    await db.query("INSERT INTO deliveries(id,notification_id,device_id) VALUES($1,$2,$3)", [uid(), notification, device]);
    expect(await nextWorkerDelay(db, idle, disabled)).toBe(idle);
    const enabled: PushGateway = { ...disabled, settings: async () => ({ ...await disabled.settings(), ready: true, androidReady: true, webReady: false }) };
    expect(await nextWorkerDelay(db, idle, enabled)).toBe(1000);
    await db.query("UPDATE users SET active=false WHERE id=$1", [user]);
    expect(await nextWorkerDelay(db, idle, enabled)).toBe(idle);
  });
  it("wakes the cloud worker after successful mutations while reads and rejected requests stay idle", async () => {
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await hash("HostedTests!2026"), user]);
    let wakeups = 0;
    const app = await createApp(db, { onMutation: () => { wakeups++; } });
    try {
      await app.inject({ method: "GET", url: "/api/health" });
      await app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "+375291234567", password: "wrong" } });
      expect(wakeups).toBe(0);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "+375291234567", password: "HostedTests!2026" } });
      expect(login.statusCode).toBe(200);
      expect(wakeups).toBe(1);
      const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: login.headers["set-cookie"]!.toString().split(";")[0], "x-csrf-token": login.json().csrf } });
      expect(logout.statusCode).toBe(200);
      expect(wakeups).toBe(2);
    } finally { await app.close(); }
  });
});
