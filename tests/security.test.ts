import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { openDatabase, type Database } from "../server/db";
import { createApp } from "../server/app";
import { ResourceGate, trustedProxies } from "../server/security";
import { uid } from "../server/domain";
import type { FastifyInstance } from "fastify";

describe("Bounded server resources", () => {
  it("bounds parallel expensive work and its waiting queue, releasing capacity after errors", async () => {
    const gate = new ResourceGate(1, 1);
    let unblock!: () => void;
    const started: string[] = [];
    const first = gate.run(async () => { started.push("first"); await new Promise<void>((resolve) => { unblock = resolve; }); throw new Error("failed operation"); });
    const failed = expect(first).rejects.toThrow("failed operation");
    const second = gate.run(async () => { started.push("second"); return "finished"; });
    await expect(gate.run(async () => "never")).rejects.toMatchObject({ status: 503, code: "SERVER_BUSY" });
    expect(started).toEqual(["first"]);
    unblock();
    await failed;
    await expect(second).resolves.toBe("finished");
    await expect(gate.run(async () => "recovered")).resolves.toBe("recovered");
  });
  it("only accepts explicitly configured proxy addresses", () => {
    expect(trustedProxies("")).toBe(false);
    expect(trustedProxies("127.0.0.1,10.0.1.0/24")).toEqual(["127.0.0.1", "10.0.1.0/24"]);
    for (const value of ["true", "0.0.0.0/0", "::/0", "127.0.0.1/33", "127.0.0.1/32/0"]) expect(() => trustedProxies(value)).toThrow();
  });
});

describe("SSE connections", () => {
  let db: Database, app: FastifyInstance, url: string;
  const controllers: AbortController[] = [];
  let polls = 0;
  const session = "sse-regression-session";
  beforeAll(async () => {
    db = await openDatabase(":memory:");
    const user = uid();
    await db.query("INSERT INTO users(id,name,phone,password_hash,role) VALUES($1,'SSE fixture','+375299999999',$2,'barista')", [user, await hash("SsePassword!2026")]);
    await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'test-csrf',clock_timestamp()+interval '1 hour')", [createHash("sha256").update(session).digest("hex"), user]);
    const instrumented: Database = {
      ...db,
      query: async (sql, params) => { if (sql.includes("s.id=ANY($1::text[])")) polls++; return db.query(sql, params); },
    };
    app = await createApp(instrumented);
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => {
    for (const controller of controllers) controller.abort();
    await app?.close();
    await db?.close();
  });
  async function connect() {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${url}/api/events`, { headers: { cookie: `rcs_session=${session}` }, signal: controller.signal });
    return { response, controller };
  }
  it("limits each user to three streams and shares one database poll", async () => {
    const connections = await Promise.all([connect(), connect(), connect()]);
    expect(connections.map(({ response }) => response.status)).toEqual([200, 200, 200]);
    const excess = await connect();
    expect(excess.response.status).toBe(429);
    expect(await excess.response.json()).toMatchObject({ code: "SSE_LIMIT" });
    const before = polls;
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(polls - before).toBeLessThanOrEqual(2);
    expect(polls - before).toBeGreaterThanOrEqual(1);
    connections[0].controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await connect()).response.status).toBe(200);
    await db.query("DELETE FROM sessions");
    const reader = connections[1].response.body!.getReader();
    let content = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      content += new TextDecoder().decode(value);
    }
    expect(content).toContain("event: revoked");
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
  });
});
