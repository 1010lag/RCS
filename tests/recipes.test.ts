import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createApp } from "../server/app";
import { openDatabase, type Database } from "../server/db";
import { uid } from "../server/domain";
import { exportDatabase, importDatabase } from "../server/database-transfer";

let db: Database, app: FastifyInstance, users: string[];
const recipe = { method: "aeropress", title: "Утренний аэропресс", coffee: "15 г", water: "220 мл", temperature: "93 °C", grind: "Средний", brew_time: "2:00", instructions: "1. Прогреть фильтр.\n2. Влить воду и перемешать.\n3. Продавить." };
function call(index: number, method: any, url: string, body?: Record<string, unknown>) {
  return app.inject({ method, url: "/api" + url, headers: { cookie: `rcs_session=recipe-session-${index}`, "x-csrf-token": "recipe-csrf" }, ...(body ? { payload: body } : {}) });
}
beforeAll(async () => { db = await openDatabase(":memory:"); app = await createApp(db); });
beforeEach(async () => {
  await db.query("TRUNCATE users,shift_types,request_limits CASCADE");
  users = [uid(), uid(), uid()];
  for (let i = 0; i < users.length; i++) {
    await db.query("INSERT INTO users(id,name,phone,password_hash,role) VALUES($1,$2,$3,'unused',$4)", [users[i], `Автор ${i}`, `+37529123456${i}`, i === 0 ? "admin" : "barista"]);
    await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'recipe-csrf',clock_timestamp()+interval '1 day')", [createHash("sha256").update(`recipe-session-${i}`).digest("hex"), users[i]]);
  }
});
afterAll(async () => { await app?.close(); await db?.close(); });

describe("Shared alternative recipes", () => {
  it("lets every employee add recipes for all methods and delete another employee's recipe", async () => {
    const ids: string[] = [];
    for (const method of ["aeropress", "v60", "bonavita"]) {
      const response = await call(1, "POST", "/recipes", { ...recipe, method });
      expect(response.statusCode, response.body).toBe(200); ids.push(response.json().id);
    }
    const list = await call(2, "GET", "/recipes");
    expect(list.json()).toHaveLength(3);
    expect(list.json()[0]).toMatchObject({ created_by: users[1], author_name: "Автор 1", instructions: recipe.instructions });
    expect((await call(2, "DELETE", `/recipes/${ids[0]}`)).statusCode).toBe(200);
    expect((await call(0, "GET", "/recipes")).json()).toHaveLength(2);
    expect((await call(1, "DELETE", `/recipes/${ids[0]}`)).statusCode).toBe(404);
    const audit = await db.query("SELECT actor_id,action FROM audit_logs WHERE entity='recipe'");
    expect(audit).toHaveLength(4); expect(audit[3].actor_id).toBe(users[2]);
    expect(await db.query("SELECT * FROM events")).toHaveLength(4);
    expect(await db.query("SELECT * FROM notifications")).toHaveLength(0);
  });
  it("requires an active signed-in account and CSRF for all mutations", async () => {
    expect((await app.inject({ method: "GET", url: "/api/recipes" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/recipes", headers: { cookie: "rcs_session=recipe-session-1" }, payload: recipe })).statusCode).toBe(403);
    await db.query("UPDATE users SET active=false WHERE id=$1", [users[1]]);
    expect((await call(1, "POST", "/recipes", recipe)).statusCode).toBe(401);
    await db.query("UPDATE users SET must_change_password=true WHERE id=$1", [users[2]]);
    expect((await call(2, "GET", "/recipes")).statusCode).toBe(200);
  });
  it("validates method, title, instructions and parameter lengths; derives the author from the session", async () => {
    for (const invalid of [{ method: "unknown" }, { title: "   " }, { instructions: "\n " }, { instructions: "x".repeat(8001) }, { coffee: "x".repeat(81) }])
      expect((await call(1, "POST", "/recipes", { ...recipe, ...invalid })).statusCode).toBe(422);
    const response = await call(1, "POST", "/recipes", { method: "v60", title: "  V60  ", instructions: "Рецепт", created_by: users[0] });
    expect(response.statusCode).toBe(200);
    expect((await call(0, "GET", "/recipes")).json()[0]).toMatchObject({ title: "V60", coffee: "", created_by: users[1] });
  });
  it("preserves recipes in database exports and restricts browser database roles", async () => {
    await call(1, "POST", "/recipes", recipe);
    const backup = await exportDatabase(db), target = await openDatabase(":memory:");
    try {
      await importDatabase(target, backup);
      expect((await target.query("SELECT title,instructions FROM recipes"))[0]).toEqual({ title: recipe.title, instructions: recipe.instructions });
      await target.query("CREATE ROLE recipe_browser NOLOGIN");
      await target.query("GRANT USAGE ON SCHEMA public TO recipe_browser");
      await target.query("GRANT SELECT ON recipes TO recipe_browser");
      expect(await target.tx(async sql => { await sql.query("SET LOCAL ROLE recipe_browser"); return sql.query("SELECT * FROM recipes"); })).toEqual([]);
    } finally { await target.close(); }
  });
});
