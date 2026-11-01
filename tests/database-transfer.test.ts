import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../server/db";
import { exportDatabase, importDatabase } from "../server/database-transfer";
import { hostedSettings } from "../server/hosting";

describe("Database transfer", () => {
  let source: Database, target: Database;
  let backup: Awaited<ReturnType<typeof exportDatabase>>;
  const user = "00000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    source = await openDatabase(":memory:");
    await source.query("INSERT INTO users(id,name,phone,password_hash,role,rate,avatar_url,created_at) VALUES($1,'Transfer fixture','+375291234567','stored-hash','admin',12.34,'data:image/png;base64,AA==','2026-11-01T10:20:30.123456+03:00')", [user]);
    await source.query("INSERT INTO sessions VALUES('existing-session',$1,'existing-csrf','2027-01-01T00:00:00Z')", [user]);
    await source.query("INSERT INTO events(id) VALUES(9007199254740993)");
    backup = await exportDatabase(source);
  });
  beforeEach(async () => { target = await openDatabase(":memory:"); });
  afterEach(async () => { await target.close(); });
  afterAll(async () => { await source.close(); });
  it("preserves credentials, avatar, SQL precision, references and the event sequence", async () => {
    const counts = await importDatabase(target, backup);
    expect(counts.users).toBe(1);
    expect(counts.sessions).toBe(1);
    expect(await target.query("SELECT password_hash,rate::text,avatar_url,to_char(created_at AT TIME ZONE 'Europe/Minsk','YYYY-MM-DD HH24:MI:SS.US') AS created FROM users")).toEqual([{ password_hash: "stored-hash", rate: "12.34", avatar_url: "data:image/png;base64,AA==", created: "2026-11-01 10:20:30.123456" }]);
    expect(await target.query("SELECT id::text FROM events")).toEqual([{ id: "9007199254740993" }]);
    expect(await target.query("INSERT INTO events DEFAULT VALUES RETURNING id::text")).toEqual([{ id: "9007199254740994" }]);
    expect((await target.query("SELECT user_id FROM sessions"))[0].user_id).toBe(user);
  });
  it("refuses to overwrite an occupied destination", async () => {
    await target.query("INSERT INTO events DEFAULT VALUES");
    await expect(importDatabase(target, backup)).rejects.toThrow("not empty");
    expect(await target.query("SELECT id FROM users")).toEqual([]);
    expect((await target.query("SELECT id FROM events")).length).toBe(1);
  });
  it("rolls back every imported table if a later record is invalid", async () => {
    const damaged = structuredClone(backup);
    damaged.tables.find(table => table.name === "sessions")!.rows[0] = JSON.stringify({ id: "bad", user_id: "00000000-0000-4000-8000-000000000099", csrf: "csrf", expires_at: "2027-01-01T00:00:00Z" });
    await expect(importDatabase(target, damaged)).rejects.toThrow();
    expect(await target.query("SELECT id FROM users")).toEqual([]);
    expect(await target.query("SELECT id FROM sessions")).toEqual([]);
  });
  it("rejects mismatched schemas before inserting data", async () => {
    const damaged = structuredClone(backup);
    damaged.tables[0].columns.push("unknown_future_column");
    await expect(importDatabase(target, damaged)).rejects.toThrow("Schema differs");
    expect(await target.query("SELECT id FROM users")).toEqual([]);
  });
  it("keeps application data private from browser database roles while the server can read it", async () => {
    await importDatabase(target, backup);
    await target.query("CREATE ROLE rcs_browser_test NOLOGIN");
    await target.query("GRANT USAGE ON SCHEMA public TO rcs_browser_test");
    await target.query("GRANT SELECT, INSERT ON users TO rcs_browser_test");
    const exposed = await target.tx(async sql => {
      await sql.query("SET LOCAL ROLE rcs_browser_test");
      return sql.query("SELECT id,phone,password_hash FROM users");
    });
    expect(exposed).toEqual([]);
    await expect(target.tx(async sql => {
      await sql.query("SET LOCAL ROLE rcs_browser_test");
      await sql.query("INSERT INTO users(id,name,phone,password_hash,role) VALUES('00000000-0000-4000-8000-000000000002','Unauthorized','+375291234568','bad','admin')");
    })).rejects.toMatchObject({ code: "42501" });
    expect((await target.query("SELECT id FROM users")).length).toBe(1);
    const policies = await target.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND NOT relrowsecurity");
    expect(policies).toEqual([]);
  });
});

describe("Hosted startup", () => {
  const database = "postgresql://user:password@db.example.com/rcs?sslmode=require";
  it("uses the assigned HTTPS address and refuses ephemeral storage or insecure origins", () => {
    expect(hostedSettings({ DATABASE_URL: database, APP_ORIGIN: "https://rcs.example.com" })).toEqual({ NODE_ENV: "production", HOST: "0.0.0.0", APP_ORIGIN: "https://rcs.example.com", WORKER_IDLE_MS: "3600000" });
    expect(hostedSettings({ DATABASE_URL: database, RENDER_EXTERNAL_URL: "https://rcs.onrender.com" }).APP_ORIGIN).toBe("https://rcs.onrender.com");
    expect(() => hostedSettings({ APP_ORIGIN: "https://rcs.example.com" })).toThrow("DATABASE_URL");
    for (const origin of ["http://localhost:3001", "https://rcs.example.com/api", "https://user:password@rcs.example.com", "https://rcs.example.com?bad=1"]) {
      expect(() => hostedSettings({ DATABASE_URL: database, APP_ORIGIN: origin })).toThrow("HTTPS origin");
    }
  });
});
