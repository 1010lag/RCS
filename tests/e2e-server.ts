import { hash } from "@node-rs/argon2";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { openDatabase } from "../server/db";
import { createApp } from "../server/app";
import { uid, localDate, dateTime, notify } from "../server/domain";
const db = await openDatabase(":memory:"),
  ids = [uid(), uid(), uid()],
  type = uid(),
  password = await hash("BrowserTests!2026"),
  today = localDate(),
  future = new Date(Date.parse(today) + 2 * 86400000)
    .toISOString()
    .slice(0, 10);
await db.tx(async (sql) => {
  for (let i = 0; i < 3; i++)
    await sql.query(
      "INSERT INTO users(id,name,phone,role,password_hash,rate) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ids[i],
        ["Александр Волков", "Анна Смирнова", "Максим Ковалёв"][i],
        `+37529000000${i}`,
        i === 0 ? "admin" : "barista",
        password,
        12 + i,
      ],
    );
  await sql.query(
    "INSERT INTO shift_types(id,name,start_time,end_time,pay_type,rate) VALUES($1,'Открытие','08:00','15:00','hourly',12)",
    [type],
  );
  const id = uid();
  await sql.query(
    "INSERT INTO shifts(id,date,start_at,end_at,type_id,user_id,status,pay_type,rate) VALUES($1,$2,$3,$4,$5,$6,'confirmed','hourly',13)",
    [
      id,
      future,
      dateTime(future, "08:00"),
      dateTime(future, "15:00"),
      type,
      ids[1],
    ],
  );
  await sql.query(
    "INSERT INTO exchange_listings(id,shift_id,listed_by,closes_at) VALUES($1,$2,$3,$4)",
    [uid(), id, ids[1], dateTime(future, "08:00")],
  );
  const nativeDay = new Date(Date.parse(today) + 6 * 86400000).toISOString().slice(0, 10);
  // A test-only session keeps this layout scenario independent of login throttling.
  await sql.query(
    "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
    [createHash("sha256").update("native-layout-test-session").digest("hex"), ids[1], "native-layout-test-csrf"],
  );
  await sql.query(
    "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
    [createHash("sha256").update("admin-ui-test-session").digest("hex"), ids[0], "admin-ui-test-csrf"],
  );
  // Long calendar navigation gets its own account, independently of mutation tests.
  const calendarAdmin = uid();
  await sql.query("INSERT INTO users(id,name,phone,role,password_hash) VALUES($1,'Календарь тест','+375299999980','admin',$2)", [calendarAdmin, password]);
  await sql.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'calendar-csrf',clock_timestamp()+interval '1 hour')", [createHash("sha256").update("calendar-ui-test-session").digest("hex"), calendarAdmin]);
  // Credential rotation has its own request budget and session; the full suite
  // must keep the production per-user rate limits enabled.
  const credentialAdmin = uid();
  await sql.query("INSERT INTO users(id,name,phone,role,password_hash) VALUES($1,'Доступ тест','+375299999979','admin',$2)", [credentialAdmin, password]);
  await sql.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'credential-csrf',clock_timestamp()+interval '1 hour')", [createHash("sha256").update("credential-ui-test-session").digest("hex"), credentialAdmin]);
  await sql.query(
    "INSERT INTO shifts(id,date,start_at,end_at,type_id,user_id,status,pay_type,rate,comment) VALUES($1,$2,$3,$4,$5,$6,'confirmed','hourly',13,'Android exchange regression')",
    [uid(), nativeDay, dateTime(nativeDay, "08:00"), dateTime(nativeDay, "15:00"), type, ids[1]],
  );
  await notify(
    sql,
    ids,
    "Добро пожаловать",
    "График уже здесь",
    "admin",
    "schedule",
  );
});
// All outbound messaging is replaced in browser tests; no real device receives a test fixture.
const app = await createApp(db, {
  clock: () => new Date(`${today}T12:00:00+03:00`),
  push: {
    settings: async () => ({
      ready: true,
      status: "ready",
      issues: [],
      config: {
        apiKey: "public-test-api-key",
        appId: "1:123456:web:test",
        projectId: "browser-tests",
        messagingSenderId: "123456",
      },
      vapidKey: "test-only",
      origin: "http://127.0.0.1:3181",
    }),
    send: async () => "browser-test-message",
  },
});
await app.register(fastifyStatic, { root: resolve("dist") });
// Device tests must verify this marker before changing any fixture accounts.
app.get("/__test/fixture", async () => ({ testOnly: true, database: ":memory:", suite: "rcs-browser-device" }));
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith("/api/")
    ? reply.code(404).send({ message: "Не найдено" })
    : reply.sendFile("index.html"),
);
await app.listen({ port: 3181, host: "127.0.0.1" });
process.once("SIGTERM", async () => {
  await app.close();
  await db.close();
});
