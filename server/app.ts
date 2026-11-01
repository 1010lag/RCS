import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";
import { z, ZodError } from "zod";
import { prepareAvatar } from "./avatar";
import { budgetKey, consumeBudget, MemoryBudget, ResourceGate, trustedProxies } from "./security";
import { StreamHub } from "./streams";
import { payrollRows } from "./payroll";
import { notificationText } from "./notification-text";
import type { Database, Sql } from "./db";
import type { User } from "../shared/types";
import { canTakeExchangeAt } from "../shared/exchange-window";
import { firebasePush, invalidPushToken, platformPushReady, type PushGateway } from "./push";
import {
  Problem,
  fail,
  uid,
  phone,
  dateTime,
  period,
  publicUser,
  audit,
  notify,
  admins,
  now,
  localDate,
  shiftForUpdate,
  expectVersion,
  assertExchange,
  assertUnadjusted,
  closeListing,
  rateFor,
  shiftProjection,
  shiftJoins,
  financeProjection,
  adjustmentJoin,
  money,
} from "./domain";
declare module "fastify" {
  interface FastifyRequest {
    user: User;
    session: { id: string; csrf: string };
    releaseCapacity: (() => void) | null;
  }
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const idSchema = z.string().uuid();
const text = z.string().trim().min(1).max(200);
const reasonSchema = z.object({
  reason: z.string().trim().min(3, "Укажите причину (от 3 символов)").max(1000),
});
const paramsId = (req: FastifyRequest) =>
  idSchema.parse((req.params as any).id);
const userSchema = z.object({
  name: text,
  phone: z.string(),
  role: z.enum(["admin", "barista"]).default("barista"),
  rate: z.string().nullable().default(null),
  pay_type: z.enum(["hourly", "shift"]).default("hourly"),
  password: z
    .string()
    .min(10, "Пароль должен содержать минимум 10 символов")
    .max(128),
  current_password: z.string().max(128).optional(),
});
const typeSchema = z.object({
  name: text,
  start_time: z.string(),
  end_time: z.string(),
  pay_type: z.enum(["hourly", "shift"]).default("hourly"),
  rate: z.string().optional(),
  allow_exchange: z.boolean().default(true),
  active: z.boolean().default(true),
});
const shiftSchema = z.object({
  date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  type_id: idSchema,
  user_id: idSchema.nullable(),
  rate_override: z.string().nullable().optional(),
  comment: z.string().max(1000).default(""),
  status: z
    .enum(["planned", "confirmed", "worked", "closed", "cancelled"])
    .default("planned"),
  exchange_locked: z.boolean().default(false),
  version: z.number().int().optional(),
  reason: z.string().max(1000).optional(),
});
export async function createApp(
  db: Database,
  options: { logger?: boolean; clock?: () => Date; push?: PushGateway } = {},
) {
  const push = options.push ?? firebasePush;
  const cpu = new ResourceGate(2, 4), requests = new ResourceGate(48), usersBudget = new MemoryBudget();
  const dummyPasswordHash = await hash(randomBytes(32).toString("hex"));
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 65536,
    trustProxy: trustedProxies(),
    requestTimeout: 15000,
  });
  await app.register(cookie);
  // Phones in one coffee shop share an IP: 20 polling clients already use
  // 600 revision requests/minute. Per-user and expensive-operation limits
  // remain separate; static assets do not consume the API request budget.
  await app.register(rateLimit, {
    global: true, max: 1200, timeWindow: "1 minute", cache: 10000,
    allowList: (req) => !req.url.startsWith("/api/"),
  });
  app.decorateRequest("releaseCapacity", null);
  app.addHook("onRequest", async (req) => {
    req.releaseCapacity = requests.enter();
    req.raw.once("aborted", req.releaseCapacity);
  });
  app.addHook("onResponse", async (req) => req.releaseCapacity?.());
  app.addHook("onError", async (req) => req.releaseCapacity?.());
  app.addHook("onTimeout", async (req) => req.releaseCapacity?.());
  // Android's HTTP stack can label a bodyless POST as an empty HTML form.
  // Accept only the empty body; API data must still use the JSON parser.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_req, body, done) => {
      if (body.length !== 0)
        return done(new Problem(415, "UNSUPPORTED_BODY", "Данные запроса должны быть в формате JSON"));
      done(null, undefined);
    },
  );
  app.decorateRequest("user", null as any);
  app.decorateRequest("session", null as any);
  app.setErrorHandler((error, req, reply) => {
    if ((error as any).retryAfter) reply.header("Retry-After", String((error as any).retryAfter));
    if ((error as any).code === "DB_BUSY") return reply.code(503).send({ code: "SERVER_BUSY", message: "Сервер занят. Попробуйте позже" });
    if (error instanceof Problem)
      return reply
        .code(error.status)
        .send({ code: error.code, message: error.message });
    if (error instanceof ZodError)
      return reply.code(422).send({
        code: "VALIDATION",
        message: error.issues[0]?.message ?? "Проверьте введённые данные",
      });
    const e = error as any;
    if (e.code === "23P01")
      return reply.code(409).send({
        code: "SHIFT_OVERLAP",
        message: "У сотрудника уже есть смена в это время",
      });
    if (e.code === "23505")
      return reply.code(409).send({
        code: "ALREADY_EXISTS",
        message: "Такая запись уже существует",
      });
    if (
      e.code === "23514" ||
      e.code === "22P02" ||
      e.code === "22007" ||
      e.code === "23503"
    )
      return reply.code(422).send({
        code: "INVALID_VALUE",
        message: "Проверьте дату, время и связанные записи",
      });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({
        code: "REQUEST_ERROR",
        message:
          e.statusCode === 429
            ? "Слишком много попыток. Попробуйте позже"
            : "Некорректный запрос",
      });
    req.log.error(error);
    return reply.code(500).send({
      code: "INTERNAL",
      message: "Не удалось выполнить действие. Повторите позже",
    });
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cache-Control", "no-store");
  });
  const originCheck = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (
      origin &&
      !new Set([
        process.env.APP_ORIGIN ?? "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
      ]).has(origin)
    )
      fail("ORIGIN_FORBIDDEN", "Запрос с этого адреса запрещён", 403);
  };
  async function auth(req: FastifyRequest) {
    const token = req.cookies.rcs_session;
    if (!token) fail("UNAUTHORIZED", "Войдите в RCS", 401);
    const s = (
      await db.query(
        "SELECT s.id AS session_id,s.csrf,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>clock_timestamp() AND u.active",
        [digest(token!)],
      )
    )[0];
    if (!s) fail("UNAUTHORIZED", "Сессия истекла. Войдите снова", 401);
    req.user = publicUser(s);
    req.session = { id: s.session_id, csrf: s.csrf };
    usersBudget.consume(req.user.id, 300, 60000);
    if (!["GET", "HEAD"].includes(req.method)) {
      originCheck(req);
      if (req.headers["x-csrf-token"] !== s.csrf)
        fail("CSRF", "Обновите страницу и повторите действие", 403);
    }
    if (
      s.must_change_password &&
      !["/api/auth/me", "/api/auth/password", "/api/auth/logout"].includes(
        req.url.split("?")[0],
      )
    )
      fail("PASSWORD_CHANGE_REQUIRED", "Сначала смените временный пароль", 403);
  }
  type Handler = (req: FastifyRequest, reply: FastifyReply) => any;
  function route(method: any, url: string, handler: Handler, admin = false, bodyLimit?: number) {
    app.route({
      method,
      url: "/api" + url,
      ...(bodyLimit ? { bodyLimit } : {}),
      preHandler: async (req) => {
        await auth(req);
        if (admin && req.user.role !== "admin")
          fail("FORBIDDEN", "Доступно только администратору", 403);
      },
      handler,
    });
  }
  const time = async (sql: Sql) => (options.clock ? options.clock() : now(sql));
  async function reauthenticate(sql: Sql, req: FastifyRequest, password?: string) {
    if (!password) fail("REAUTH_REQUIRED", "Введите текущий пароль администратора", 403);
    const actor = (await sql.query("SELECT password_hash FROM users WHERE id=$1 AND active FOR SHARE", [req.user.id]))[0];
    if (!actor || !(await cpu.run(() => verify(actor.password_hash, password!)))) fail("REAUTH_FAILED", "Текущий пароль неверен", 403);
  }
  async function rotateSessions(sql: Sql, userId: string) {
    const token = randomBytes(32).toString("hex"), csrf = randomBytes(24).toString("hex");
    await sql.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
    await sql.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '7 days')", [digest(token), userId, csrf]);
    return { token, csrf };
  }
  function applySession(reply: FastifyReply, session: { token: string; csrf: string }) {
    reply.header("X-CSRF-Token", session.csrf).setCookie("rcs_session", session.token, {
      httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 604800,
    });
  }
  const range = (req: FastifyRequest) => {
    const q = req.query as any;
    const today = localDate(options.clock?.() ?? new Date());
    return period(
      q.from ?? today,
      q.to ?? today,
    );
  };
  app.get("/api/health", async () => ({ ok: true }));
  app.post(
    "/api/auth/login",
    async (req, reply) => {
      originCheck(req);
      const body = z
        .object({ phone: z.string(), password: z.string().max(128) })
        .parse(req.body);
      const normalizedPhone = phone(body.phone);
      await consumeBudget(db, budgetKey("login-ip", req.ip), 20, 60000);
      const accountKey = budgetKey("login-account", normalizedPhone);
      await consumeBudget(db, accountKey, 8, 15 * 60000);
      const u = (
        await db.query("SELECT * FROM users WHERE phone=$1 AND active", [
          normalizedPhone,
        ])
      )[0];
      // Hash once for a missing user as well, so login timing does not identify accounts.
      const valid = await cpu.run(() => verify(u?.password_hash ?? dummyPasswordHash, body.password));
      if (!u || !valid)
        fail("LOGIN_FAILED", "Неверный телефон или пароль", 401);
      await db.query("DELETE FROM request_limits WHERE key=$1", [accountKey]);
      const token = randomBytes(32).toString("hex"),
        csrf = randomBytes(24).toString("hex");
      await db.query(
        "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '7 days')",
        [digest(token), u.id, csrf],
      );
      reply.setCookie("rcs_session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 604800,
      });
      return {
        user: publicUser(u),
        csrf,
        server_now: (await time(db)).toISOString(),
      };
    },
  );
  route("GET", "/auth/me", async (req) => {
    const settings = await push.settings();
    return {
      user: req.user,
      csrf: req.session.csrf,
      server_now: (await time(db)).toISOString(),
      push_config: settings.ready ? settings.config : null,
      vapid_key: settings.ready ? settings.vapidKey : null,
      push_ready: platformPushReady(settings, "web"),
      push_android_ready: platformPushReady(settings, "android"),
      push_project_id: settings.projectId ?? settings.config?.projectId ?? null,
    };
  });
  route("POST", "/auth/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE id=$1", [req.session.id]);
    reply.clearCookie("rcs_session", { path: "/" });
    return { ok: true };
  });
  route("POST", "/auth/password", async (req, reply) => {
    const b = z
      .object({ current: z.string(), password: z.string().min(10).max(128) })
      .parse(req.body);
    await consumeBudget(db, budgetKey("password", req.user.id), 5, 15 * 60000);
    const u = (
      await db.query("SELECT password_hash FROM users WHERE id=$1", [
        req.user.id,
      ])
    )[0];
    if (!(await cpu.run(() => verify(u.password_hash, b.current))))
      fail("LOGIN_FAILED", "Текущий пароль неверен", 403);
    const hashed = await cpu.run(() => hash(b.password));
    const session = await db.tx(async (sql) => {
      await sql.query(
        "UPDATE users SET password_hash=$1,must_change_password=false,version=version+1 WHERE id=$2",
        [hashed, req.user.id],
      );
      const replacement = await rotateSessions(sql, req.user.id);
      await audit(sql, req.user.id, "Пароль изменён", "user", req.user.id);
      return replacement;
    });
    applySession(reply, session);
    return { ok: true };
  });
  route(
    "GET",
    "/revision",
    async () =>
      (
        await db.query(
          "SELECT COALESCE(max(id),0)::text AS revision FROM events",
        )
      )[0],
  );
  route("GET", "/team", () =>
    db.query("SELECT id,name,avatar_url FROM users WHERE active ORDER BY name"),
  );
  route("PATCH", "/me/name", async (req) => {
    const body = z.object({ name: text.transform((value) => value.replace(/\s+/g, " ")), version: z.number().int() }).parse(req.body);
    return db.tx(async (sql) => {
      const old = (await sql.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [req.user.id]))[0];
      expectVersion(old, body.version);
      const updated = (await sql.query("UPDATE users SET name=$1,version=version+1 WHERE id=$2 RETURNING *", [body.name, req.user.id]))[0];
      await audit(sql, req.user.id, "Имя и фамилия изменены", "user", req.user.id, { name: old.name }, { name: updated.name });
      return publicUser(updated);
    });
  });
  route("PUT", "/me/avatar", async (req) => {
    const { image } = z.object({ image: z.string().max(360000).nullable() }).parse(req.body);
    await consumeBudget(db, budgetKey("avatar", req.user.id), 3, 5 * 60000);
    const avatar = image === null ? null : await cpu.run(() => prepareAvatar(image));
    return db.tx(async (sql) => {
      const updated = (await sql.query("UPDATE users SET avatar_url=$1,version=version+1 WHERE id=$2 RETURNING *", [avatar, req.user.id]))[0];
      await audit(sql, req.user.id, avatar ? "Аватар обновлён" : "Аватар удалён", "user", req.user.id, null, { has_avatar: Boolean(avatar) });
      return publicUser(updated);
    });
  }, false, 400000);
  route(
    "GET",
    "/employees",
    async () =>
      (await db.query("SELECT * FROM users ORDER BY active DESC,name")).map(
        publicUser,
      ),
    true,
  );
  route(
    "POST",
    "/employees",
    async (req) => {
      const b = userSchema.parse(req.body),
        id = uid();
      await consumeBudget(db, budgetKey("employee-create", req.user.id), 10, 15 * 60000);
      const clean = {
        ...b,
        phone: phone(b.phone),
        rate: b.rate === null ? null : money(b.rate),
      };
      return db.tx(async (sql) => {
        if (b.role === "admin") await reauthenticate(sql, req, b.current_password);
        const hashed = await cpu.run(() => hash(b.password));
        const u = (
          await sql.query(
            "INSERT INTO users(id,name,phone,role,rate,pay_type,password_hash,must_change_password) VALUES($1,$2,$3,$4,$5,$6,$7,true) RETURNING *",
            [
              id,
              clean.name,
              clean.phone,
              clean.role,
              clean.rate,
              clean.pay_type,
              hashed,
            ],
          )
        )[0];
        await audit(
          sql,
          req.user.id,
          "Сотрудник добавлен",
          "user",
          id,
          null,
          publicUser(u),
        );
        return publicUser(u);
      });
    },
    true,
  );
  route(
    "PATCH",
    "/employees/:id",
    async (req, reply) => {
      const id = paramsId(req),
        b = z
          .object({
            name: text,
            phone: z.string(),
            rate: z.string().nullable(),
            pay_type: z.enum(["hourly", "shift"]),
            active: z.boolean(),
            version: z.number().int(),
            reason: z.string().trim().min(3),
            password: z.string().min(10, "Пароль должен содержать минимум 10 символов").max(128).optional(),
            current_password: z.string().max(128).optional(),
          })
          .parse(req.body);
      if (b.password || b.current_password) await consumeBudget(db, budgetKey("credentials", req.user.id), 5, 15 * 60000);
      let replacement: { token: string; csrf: string } | undefined;
      const updated = await db.tx(async (sql) => {
        if (!b.active) {
          // Serialize administrator removals so two concurrent actions cannot remove all admins.
          await sql.query("SELECT id FROM users WHERE role='admin' AND active ORDER BY id FOR UPDATE");
        }
        const old = (
          await sql.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
        )[0];
        if (!old) fail("NOT_FOUND", "Сотрудник не найден", 404);
        expectVersion(old, b.version);
        const sensitive = Boolean(b.password) || phone(b.phone) !== old.phone;
        if (sensitive && old.role === "admin" && id !== req.user.id)
          fail("ADMIN_CREDENTIALS_FORBIDDEN", "Администратор может менять данные для входа только своего аккаунта", 403);
        if (sensitive) await reauthenticate(sql, req, b.current_password);
        if (sensitive) {
          if (!b.active) fail("INACTIVE_USER", "Для смены данных сначала восстановите сотрудника");
          if (id === req.user.id) replacement = await rotateSessions(sql, id);
          else await sql.query("DELETE FROM sessions WHERE user_id=$1", [id]);
          await sql.query("DELETE FROM push_devices WHERE user_id=$1", [id]);
        }
        const newPasswordHash = b.password ? await cpu.run(() => hash(b.password!)) : null;
        if (newPasswordHash) {
          if (!b.active) fail("INACTIVE_USER", "Для смены пароля сначала восстановите сотрудника");
          await sql.query("UPDATE users SET password_hash=$1,must_change_password=$2 WHERE id=$3", [newPasswordHash, id !== req.user.id, id]);
          await audit(sql, req.user.id, "Пароль сотрудника изменён", "user", id, null, { other_sessions_revoked: true }, b.reason);
        }
        if (!b.active) {
          if (old.role === "admin" && (await admins(sql)).length <= 1)
            fail("LAST_ADMIN", "Нельзя отключить последнего администратора");
          if (id === req.user.id)
            fail("SELF_DELETE", "Нельзя удалить свой аккаунт. Попросите другого администратора", 409);
          const dismissedAt = await time(sql);
          const assigned = await sql.query(
            "SELECT id,status,start_at,end_at FROM shifts WHERE user_id=$1 AND status NOT IN ('cancelled','worked','closed') AND end_at>$2 ORDER BY id FOR UPDATE",
            [id, dismissedAt],
          );
          for (const shift of assigned) {
            const future = new Date(shift.start_at) > dismissedAt;
            if (future) await sql.query("UPDATE shifts SET status='cancelled',version=version+1,updated_at=clock_timestamp() WHERE id=$1", [shift.id]);
            else {
              const minute = Math.floor(dismissedAt.getTime() / 60000) * 60000;
              const end = new Date(Math.min(new Date(shift.end_at).getTime(), Math.max(new Date(shift.start_at).getTime() + 60000, minute)));
              await sql.query("UPDATE shifts SET end_at=$1,version=version+1,updated_at=clock_timestamp() WHERE id=$2", [end, shift.id]);
              await audit(sql, req.user.id, "Смена завершена досрочно при удалении сотрудника", "shift", shift.id,
                { end_at: shift.end_at }, { end_at: end.toISOString() }, b.reason);
            }
            await closeListing(sql, shift.id);
            if (future) await audit(sql, req.user.id, "Смена отменена при удалении сотрудника", "shift", shift.id,
              { status: shift.status, user_id: id }, { status: "cancelled", user_id: id }, b.reason);
          }
          await sql.query("UPDATE exchange_listings SET status='cancelled' WHERE listed_by=$1 AND status='open'", [id]);
          await sql.query("DELETE FROM sessions WHERE user_id=$1", [id]);
          await sql.query("DELETE FROM push_devices WHERE user_id=$1", [id]);
        }
        const u = (
          await sql.query(
            "UPDATE users SET name=$1,phone=$2,rate=$3,pay_type=$4,active=$5,version=version+1 WHERE id=$6 RETURNING *",
            [
              b.name,
              phone(b.phone),
              b.rate === null ? null : money(b.rate),
              b.pay_type,
              b.active,
              id,
            ],
          )
        )[0];
        await audit(
          sql,
          req.user.id,
          old.active && !b.active ? "Сотрудник удалён из команды" : "Сотрудник изменён",
          "user",
          id,
          publicUser(old),
          publicUser(u),
          b.reason,
        );
        return publicUser(u);
      });
      if (replacement) applySession(reply, replacement);
      return updated;
    },
    true,
  );
  route(
    "PATCH",
    "/employees/:id/hourly-rate",
    (req) =>
      db.tx(async (sql) => {
        const id = paramsId(req);
        const body = z
          .object({
            rate: z.string(),
            version: z.number().int(),
            apply_to_future: z.boolean().default(false),
            reason: z.string().trim().min(3).max(1000),
          })
          .parse(req.body);
        const rate = money(body.rate);
        const old = (
          await sql.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
        )[0];
        if (!old) fail("NOT_FOUND", "Сотрудник не найден", 404);
        expectVersion(old, body.version);
        await sql.query(
          "UPDATE users SET rate=$1,pay_type='hourly',version=version+1 WHERE id=$2",
          [rate, id],
        );
        let changed = 0;
        if (body.apply_to_future) {
          const shifts = await sql.query(
            "SELECT id,rate::text FROM shifts WHERE user_id=$1 AND start_at>$2 AND status IN ('planned','confirmed') AND pay_type='hourly' AND NOT rate_override FOR UPDATE",
            [id, await time(sql)],
          );
          for (const s of shifts) {
            await sql.query(
              "UPDATE shifts SET rate=$1,version=version+1,updated_at=clock_timestamp() WHERE id=$2",
              [rate, s.id],
            );
            await closeListing(sql, s.id);
            await audit(
              sql,
              req.user.id,
              "Почасовая ставка смены обновлена",
              "shift",
              s.id,
              { rate: s.rate },
              { rate },
              body.reason,
            );
          }
          changed = shifts.length;
        }
        await audit(
          sql,
          req.user.id,
          "Почасовая ставка сотрудника изменена",
          "user",
          id,
          { rate: old.rate, pay_type: old.pay_type },
          { rate, pay_type: "hourly", updated_shifts: changed },
          body.reason,
        );
        await notify(
          sql,
          [id],
          "Ваша почасовая ставка изменена",
          changed
            ? "Обновлена ставка и расчёт будущих почасовых смен. Подробности — в ваших начислениях."
            : "Новая ставка будет применяться при создании новых почасовых смен.",
          "adjustments",
          "payroll",
        );
        return { rate, pay_type: "hourly", updated_shifts: changed };
      }),
    true,
  );
  route("GET", "/shift-types", (req) =>
    db.query(
      req.user.role === "admin"
        ? "SELECT id,name,start_time::text,end_time::text,pay_type,rate::text,allow_exchange,active,version FROM shift_types ORDER BY active DESC,start_time"
        : "SELECT id,name,start_time::text,end_time::text,allow_exchange,active,version FROM shift_types WHERE active ORDER BY start_time",
    ),
  );
  async function saveType(req: FastifyRequest, update = false) {
    const b = typeSchema.parse(req.body),
      id = update ? paramsId(req) : uid();
    dateTime("2026-01-01", b.start_time);
    dateTime("2026-01-01", b.end_time);
    if (b.start_time >= b.end_time)
      fail("OVERNIGHT", "Начало и окончание должны быть в одном дне");
    return db.tx(async (sql) => {
      let old = null;
      if (update) {
        old = (
          await sql.query("SELECT * FROM shift_types WHERE id=$1 FOR UPDATE", [
            id,
          ])
        )[0];
        if (!old) fail("NOT_FOUND", "Тип смены не найден", 404);
        expectVersion(
          old,
          z.object({ version: z.number().int() }).parse(req.body).version,
        );
      }
      const args = [
        b.name,
        b.start_time,
        b.end_time,
        b.pay_type,
        b.pay_type === "hourly" ? "0.00" : money(b.rate ?? fail("FIXED_RATE_REQUIRED", "Укажите оплату за смену")),
        b.allow_exchange,
        b.active,
        id,
      ];
      await sql.query(
        update
          ? "UPDATE shift_types SET name=$1,start_time=$2,end_time=$3,pay_type=$4,rate=$5,allow_exchange=$6,active=$7,version=version+1 WHERE id=$8"
          : "INSERT INTO shift_types(name,start_time,end_time,pay_type,rate,allow_exchange,active,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        args,
      );
      if (!b.allow_exchange || !b.active)
        await sql.query(
          "UPDATE exchange_listings SET status='cancelled' WHERE status='open' AND shift_id IN (SELECT id FROM shifts WHERE type_id=$1)",
          [id],
        );
      await audit(
        sql,
        req.user.id,
        update ? (old?.active && !b.active ? "Тип смены удалён" : "Тип смены изменён") : "Тип смены создан",
        "shift_type",
        id,
        old,
        b,
      );
      return { id };
    });
  }
  route("POST", "/shift-types", (req) => saveType(req), true);
  route("PATCH", "/shift-types/:id", (req) => saveType(req, true), true);
  route("GET", "/schedule", async (req) => {
    const [from, to] = range(req);
    return db.query(
      `SELECT ${shiftProjection} ${req.user.role === "admin" ? financeProjection : ""} ${shiftJoins} ${req.user.role === "admin" ? adjustmentJoin : ""} WHERE s.date BETWEEN $1 AND $2 AND (s.user_id IS NULL OR u.active OR s.end_at<=$3) ORDER BY s.start_at,u.name`,
      [from, to, await time(db)],
    );
  });
  route("GET", "/me/shifts", async (req) => {
    const [from, to] = range(req);
    return db.query(
      `SELECT ${shiftProjection} ${financeProjection} ${shiftJoins} ${adjustmentJoin} WHERE s.user_id=$1 AND s.date BETWEEN $2 AND $3 ORDER BY s.start_at`,
      [req.user.id, from, to],
    );
  });
  route("GET", "/shifts/:id", async (req) => {
    const id = paramsId(req);
    const own = (
      await db.query("SELECT user_id FROM shifts WHERE id=$1", [id])
    )[0];
    if (!own) fail("NOT_FOUND", "Смена не найдена", 404);
    const financial = req.user.role === "admin" || own.user_id === req.user.id;
    return (
      await db.query(
        `SELECT ${shiftProjection} ${financial ? financeProjection : ""} ${shiftJoins} ${financial ? adjustmentJoin : ""} WHERE s.id=$1`,
        [id],
      )
    )[0];
  });
  async function writeShift(
    sql: Sql,
    actor: string,
    b: z.infer<typeof shiftSchema>,
    id: string = uid(),
    old: any = null,
  ) {
    const start = dateTime(b.date, b.start_time),
      end = dateTime(b.date, b.end_time);
    if (start >= end)
      fail(
        "OVERNIGHT",
        "Ночные смены не поддерживаются. Начало должно быть раньше окончания в одном дне",
      );
    const type = (
      await sql.query("SELECT * FROM shift_types WHERE id=$1 FOR SHARE", [
        b.type_id,
      ])
    )[0];
    if (!type?.active) fail("INACTIVE_TYPE", "Выберите активный тип смены");
    const u = b.user_id
      ? (
          await sql.query("SELECT * FROM users WHERE id=$1 FOR SHARE", [
            b.user_id,
          ])
        )[0]
      : null;
    if (b.user_id && !u?.active)
      fail("INACTIVE_USER", "Выберите активного сотрудника");
    if (old) {
      expectVersion(old, b.version ?? 0);
      if (
        old.status === "closed" ||
        ["worked", "closed"].includes(b.status) ||
        new Date(old.start_at) <= (await time(sql))
      )
        reasonSchema.parse(b);
      await closeListing(sql, id);
      if (
        old.user_id !== b.user_id &&
        (
          await sql.query(
            "SELECT id FROM adjustments WHERE shift_id=$1 LIMIT 1",
            [id],
          )
        ).length
      )
        fail(
          "ADJUSTED_OWNER",
          "У смены есть корректировки: изменять сотрудника нельзя",
        );
    }
    if (
      ["worked", "closed"].includes(b.status) &&
      new Date(end) > (await time(sql))
    )
      fail("FUTURE_WORKED", "Будущую смену нельзя отметить отработанной");
    const preserve =
      old &&
      old.user_id === b.user_id &&
      old.type_id === b.type_id &&
      b.rate_override == null;
    const rate =
      b.rate_override != null
        ? money(b.rate_override)
        : preserve
          ? old.rate
          : rateFor(type, u);
    const payType = preserve ? old.pay_type : type.pay_type;
    const args = [
      b.date,
      start,
      end,
      b.type_id,
      b.user_id,
      b.status,
      payType,
      rate,
      preserve ? old.rate_override : b.rate_override != null,
      b.comment,
      b.exchange_locked,
      id,
    ];
    await sql.query(
      old
        ? "UPDATE shifts SET date=$1,start_at=$2,end_at=$3,type_id=$4,user_id=$5,status=$6,pay_type=$7,rate=$8,rate_override=$9,comment=$10,exchange_locked=$11,version=version+1,updated_at=clock_timestamp() WHERE id=$12"
        : "INSERT INTO shifts(date,start_at,end_at,type_id,user_id,status,pay_type,rate,rate_override,comment,exchange_locked,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      args,
    );
    await audit(
      sql,
      actor,
      old ? "Смена изменена" : "Смена создана",
      "shift",
      id,
      old ? { date: old.date, user_id: old.user_id, status: old.status } : null,
      { date: b.date, user_id: b.user_id, status: b.status },
      b.reason,
    );
    if (old?.user_id && old.user_id !== b.user_id) await notify(sql, [old.user_id].filter((user) => user !== actor),
      "Смена снята с вашего графика", `${old.date} · Вы больше не назначены на эту смену`, "schedule", "schedule");
    await notify(sql, [b.user_id].filter((user) => user !== actor),
      old?.user_id === b.user_id ? (b.status === "cancelled" ? "Смена отменена" : "Ваша смена изменена") : "Вам назначена смена",
      `${b.date} · ${b.start_time}–${b.end_time}`, "schedule", `shift:${id}`);
    return { id };
  }
  route(
    "POST",
    "/shifts",
    (req) =>
      db.tx((sql) => writeShift(sql, req.user.id, shiftSchema.parse(req.body))),
    true,
  );
  route(
    "PATCH",
    "/shifts/:id",
    (req) =>
      db.tx(async (sql) => {
        const id = paramsId(req);
        return writeShift(
          sql,
          req.user.id,
          shiftSchema.parse(req.body),
          id,
          await shiftForUpdate(sql, id),
        );
      }),
    true,
  );
  route("POST", "/shifts/batch", async (req) => {
    const body = z.object({
      date: z.string(),
      assignments: z.array(z.object({ user_id: idSchema.nullable(), type_id: idSchema, type_version: z.number().int().positive() })).min(1).max(50),
      status: z.enum(["planned", "confirmed"]).default("confirmed"),
      comment: z.string().max(1000).default(""),
      exchange_locked: z.boolean().default(false),
    }).parse(req.body);
    period(body.date, body.date);
    const key = z.string().min(10).max(100).parse(req.headers["idempotency-key"]);
    const requestHash = digest("batch-shifts:" + JSON.stringify(body));
    return db.tx(async (sql) => {
      const previous = (await sql.query("SELECT request_hash,response FROM idempotency WHERE user_id=$1 AND key=$2 FOR UPDATE", [req.user.id, key]))[0];
      if (previous) {
        if (previous.request_hash !== requestHash) fail("IDEMPOTENCY_MISMATCH", "Данные назначения изменились. Повторите сохранение", 409);
        return previous.response;
      }
      const types = await sql.query("SELECT * FROM shift_types WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE", [[...new Set(body.assignments.map((item) => item.type_id))]]);
      const people = await sql.query("SELECT id,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE", [body.assignments.map((item) => item.user_id).filter(Boolean)]);
      const ids: string[] = [];
      for (const assignment of body.assignments) {
        const type = types.find((type) => type.id === assignment.type_id);
        if (!type?.active) fail("INACTIVE_TYPE", "Один из типов смен недоступен. Ничего не сохранено");
        expectVersion(type, assignment.type_version);
        const person = people.find((person) => person.id === assignment.user_id)?.name ?? "Неназначенная смена";
        try {
          const created = await writeShift(sql, req.user.id, {
            date: body.date, type_id: type.id, user_id: assignment.user_id,
            start_time: type.start_time.slice(0, 5), end_time: type.end_time.slice(0, 5),
            status: body.status, comment: body.comment, exchange_locked: body.exchange_locked,
          });
          ids.push(created.id);
        } catch (error) {
          if ((error as any).code === "23P01") fail("BATCH_SHIFT_OVERLAP", `${person}: уже есть смена в это время. Вся группа не сохранена`, 409);
          if (error instanceof Problem) throw new Problem(error.status, error.code, `${person}: ${error.message}. Вся группа не сохранена`);
          throw error;
        }
      }
      const response = { ids, count: ids.length };
      await sql.query("INSERT INTO idempotency(user_id,key,request_hash,response) VALUES($1,$2,$3,$4)", [req.user.id, key, requestHash, response]);
      return response;
    });
  }, true);
  route(
    "DELETE",
    "/shifts/:id",
    (req) =>
      db.tx(async (sql) => {
        const b = reasonSchema
            .extend({ version: z.number().int() })
            .parse(req.body),
          s = await shiftForUpdate(sql, paramsId(req));
        expectVersion(s, b.version);
        await closeListing(sql, s.id);
        await sql.query(
          "UPDATE shifts SET status='cancelled',version=version+1 WHERE id=$1",
          [s.id],
        );
        await audit(
          sql,
          req.user.id,
          "Смена отменена",
          "shift",
          s.id,
          { status: s.status },
          { status: "cancelled" },
          b.reason,
        );
        await notify(
          sql,
          [s.user_id],
          "Смена отменена",
          `${s.date} · ${b.reason}`,
          "schedule",
          `shift:${s.id}`,
        );
        return { ok: true };
      }),
    true,
  );
  route("GET", "/exchange", async (req) => {
    const q = req.query as any;
    const history = q.history === "true";
    return db.query(
      `SELECT l.id,l.shift_id,l.status,l.taken_by,tu.name AS taken_name,l.closes_at,s.date::text,to_char(s.start_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS start_time,to_char(s.end_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS end_time,t.name AS type_name,l.listed_by AS user_id,u.name AS user_name,s.version FROM exchange_listings l JOIN shifts s ON s.id=l.shift_id JOIN users u ON u.id=l.listed_by JOIN shift_types t ON t.id=s.type_id LEFT JOIN users tu ON tu.id=l.taken_by WHERE ${history ? (req.user.role === "admin" ? "true" : "(l.listed_by=$1 OR l.taken_by=$1)") : "l.status='open' AND l.closes_at>clock_timestamp() AND s.status NOT IN ('cancelled','closed','worked') AND NOT s.exchange_locked AND t.allow_exchange AND t.active AND NOT EXISTS (SELECT 1 FROM adjustments ax WHERE ax.shift_id=s.id)"} ORDER BY s.start_at DESC LIMIT 200`,
      history && req.user.role !== "admin" ? [req.user.id] : [],
    );
  });
  route("POST", "/shifts/:id/exchange", (req) =>
    db.tx(async (sql) => {
      const s = await shiftForUpdate(sql, paramsId(req));
      if (s.user_id !== req.user.id && req.user.role !== "admin")
        fail("FORBIDDEN", "Можно выставить только свою смену", 403);
      if (!s.user_id) fail("NO_OWNER", "Сначала назначьте сотрудника");
      await assertExchange(sql, s, await time(sql));
      await consumeBudget(sql, budgetKey("exchange-publish", req.user.id), 5, 15 * 60000);
      if ((await sql.query("SELECT id FROM exchange_listings WHERE shift_id=$1 AND created_at>clock_timestamp()-interval '1 minute' LIMIT 1", [s.id])).length)
        fail("LISTING_COOLDOWN", "Повторная публикация доступна через минуту", 429);
      const id = uid();
      await sql.query(
        "INSERT INTO exchange_listings(id,shift_id,listed_by,closes_at) VALUES($1,$2,$3,LEAST($4::timestamptz,($5::date+time '19:00') AT TIME ZONE 'Europe/Minsk'))",
        [id, s.id, s.user_id, s.start_at, s.date],
      );
      await sql.query("UPDATE shifts SET version=version+1 WHERE id=$1", [
        s.id,
      ]);
      await audit(
        sql,
        req.user.id,
        "Смена выставлена на биржу",
        "exchange",
        id,
        null,
        { shift_id: s.id },
      );
      const team = (await sql.query("SELECT id FROM users WHERE active AND id<>$1 AND id<>$2", [s.user_id, req.user.id])).map(
        (x) => x.id,
      );
      await notify(
        sql,
        team,
        "Новая смена на бирже",
        `${s.date} · Посмотрите свободную смену`,
        "exchange",
        "exchange",
        `exchange-published:${s.id}`,
      );
      return { id };
    }),
  );
  route("POST", "/exchange/:id/withdraw", (req) =>
    db.tx(async (sql) => {
      const id = paramsId(req),
        candidate = (
          await sql.query(
            "SELECT shift_id FROM exchange_listings WHERE id=$1",
            [id],
          )
        )[0];
      if (!candidate) fail("NOT_FOUND", "Объявление не найдено", 404);
      const s = await shiftForUpdate(sql, candidate.shift_id);
      const l = (
        await sql.query(
          "SELECT * FROM exchange_listings WHERE id=$1 FOR UPDATE",
          [id],
        )
      )[0];
      if (l.listed_by !== req.user.id && req.user.role !== "admin")
        fail("FORBIDDEN", "Чужое объявление", 403);
      if (l.status !== "open")
        fail("LISTING_CLOSED", "Объявление уже закрыто", 409);
      if ((await time(sql)) >= new Date(l.closes_at))
        fail("LISTING_CLOSED", "Время передачи уже истекло", 409);
      await sql.query(
        "UPDATE exchange_listings SET status='cancelled' WHERE id=$1",
        [id],
      );
      await sql.query("UPDATE shifts SET version=version+1 WHERE id=$1", [
        s.id,
      ]);
      await audit(sql, req.user.id, "Объявление отозвано", "exchange", id);
      return { ok: true };
    }),
  );
  async function quote(sql: Sql, s: any, userId: string) {
    const type = await assertExchange(sql, s, await time(sql));
    const u = (
      await sql.query("SELECT * FROM users WHERE id=$1 AND active FOR SHARE", [
        userId,
      ])
    )[0];
    if (!u) fail("INACTIVE_USER", "Сотрудник неактивен", 403);
    const rate = rateFor(type, u, s.rate_override ? s.rate : null);
    const pay_type = s.rate_override ? s.pay_type : type.pay_type;
    const minutes = Math.round(
      (new Date(s.end_at).getTime() - new Date(s.start_at).getTime()) / 60000,
    );
    const { amount } = await import("./domain");
    return {
      rate,
      pay_type,
      minutes,
      amount: amount(minutes, rate, pay_type),
      version: `${s.version}:${type.version}:${u.version}`,
    };
  }
  route("GET", "/exchange/:id/quote", (req) =>
    db.tx(async (sql) => {
      const l = (
        await sql.query(
          "SELECT * FROM exchange_listings WHERE id=$1 AND status='open'",
          [paramsId(req)],
        )
      )[0];
      if (!l) fail("EXCHANGE_ALREADY_TAKEN", "Эту смену уже забрали", 409);
      const s = await shiftForUpdate(sql, l.shift_id);
      return quote(sql, s, req.user.id);
    }),
  );
  route("POST", "/exchange/:id/take", (req) =>
    db.tx(async (sql) => {
      if (req.user.role !== "barista")
        fail("FORBIDDEN", "Админ меняет назначение через редактор смены", 403);
      const id = paramsId(req),
        b = z.object({ version: z.string() }).parse(req.body),
        key = z.string().min(10).max(100).parse(req.headers["idempotency-key"]);
      await sql.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        req.user.id,
      ]);
      const requestHash = digest(JSON.stringify({ id, ...b })),
        previous = (
          await sql.query(
            "SELECT * FROM idempotency WHERE user_id=$1 AND key=$2",
            [req.user.id, key],
          )
        )[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          fail("IDEMPOTENCY_MISMATCH", "Ключ запроса уже использован", 409);
        return previous.response;
      }
      const candidate = (
        await sql.query("SELECT shift_id FROM exchange_listings WHERE id=$1", [
          id,
        ])
      )[0];
      if (!candidate) fail("NOT_FOUND", "Объявление не найдено", 404);
      const s = await shiftForUpdate(sql, candidate.shift_id),
        l = (
          await sql.query(
            "SELECT * FROM exchange_listings WHERE id=$1 FOR UPDATE",
            [id],
          )
        )[0];
      if (l.status !== "open")
        fail("EXCHANGE_ALREADY_TAKEN", "Эту смену уже забрали", 409);
      if (s.user_id === req.user.id)
        fail("OWN_SHIFT", "Нельзя забрать свою смену", 409);
      const q = await quote(sql, s, req.user.id);
      if (!canTakeExchangeAt(await time(sql))) fail("EXCHANGE_HOURS", "Забирать смены на бирже можно с 10:00 до 19:00 по Минску", 409);
      if (q.version !== b.version)
        fail(
          "QUOTE_CHANGED",
          "Условия изменились. Проверьте новый расчёт",
          409,
        );
      await sql.query(
        "UPDATE shifts SET user_id=$1,rate=$2,pay_type=$3,exchanged=true,version=version+1 WHERE id=$4",
        [req.user.id, q.rate, q.pay_type, s.id],
      );
      await sql.query(
        "UPDATE exchange_listings SET status='taken',taken_by=$1,taken_at=clock_timestamp(),old_pay_type=$2,old_rate=$3 WHERE id=$4",
        [req.user.id, s.pay_type, s.rate, id],
      );
      await audit(
        sql,
        req.user.id,
        "Смена забрана с биржи",
        "exchange",
        id,
        { user_id: s.user_id },
        { user_id: req.user.id, shift_id: s.id },
      );
      await notify(
        sql,
        [s.user_id, req.user.id, ...(await admins(sql))],
        "Смена передана",
        `${s.date} · Новый ответственный: ${req.user.name}`,
        "exchange",
        `shift:${s.id}`,
      );
      const response = { ok: true, shift_id: s.id };
      await sql.query(
        "INSERT INTO idempotency(user_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
        [req.user.id, key, requestHash, JSON.stringify(response)],
      );
      return response;
    }),
  );
  route(
    "POST",
    "/exchange/:id/rollback",
    (req) =>
      db.tx(async (sql) => {
        const id = paramsId(req),
          b = reasonSchema.parse(req.body),
          candidate = (
            await sql.query(
              "SELECT shift_id FROM exchange_listings WHERE id=$1",
              [id],
            )
          )[0];
        if (!candidate) fail("NOT_FOUND", "Объявление не найдено", 404);
        const s = await shiftForUpdate(sql, candidate.shift_id),
          l = (
            await sql.query(
              "SELECT * FROM exchange_listings WHERE id=$1 FOR UPDATE",
              [id],
            )
          )[0];
        if (l.status !== "taken" || s.user_id !== l.taken_by)
          fail(
            "ROLLBACK_CONFLICT",
            "Назначение уже изменилось. Используйте редактор смены",
            409,
          );
        await assertUnadjusted(sql, s.id);
        if ((await time(sql)) >= new Date(s.start_at))
          fail(
            "SHIFT_STARTED",
            "Для начавшейся смены используйте административное исправление",
            409,
          );
        if (
          !(
            await sql.query("SELECT id FROM users WHERE id=$1 AND active", [
              l.listed_by,
            ])
          ).length
        )
          fail("INACTIVE_USER", "Прежний сотрудник неактивен", 409);
        await sql.query(
          "UPDATE shifts SET user_id=$1,rate=$2,pay_type=$3,version=version+1 WHERE id=$4",
          [l.listed_by, l.old_rate, l.old_pay_type, s.id],
        );
        await sql.query(
          "UPDATE exchange_listings SET status='rolled_back' WHERE id=$1",
          [id],
        );
        await audit(
          sql,
          req.user.id,
          "Обмен отменён администратором",
          "exchange",
          id,
          { user_id: l.taken_by },
          { user_id: l.listed_by },
          b.reason,
        );
        await notify(
          sql,
          [l.listed_by, l.taken_by, ...(await admins(sql))],
          "Обмен отменён",
          b.reason,
          "exchange",
          `shift:${s.id}`,
        );
        return { ok: true };
      }),
    true,
  );
  route(
    "POST",
    "/shifts/:id/adjustments",
    (req) =>
      db.tx(async (sql) => {
        const b = reasonSchema
            .extend({
              minutes: z.number().int().min(-1440).max(1440),
              amount: z.string().regex(/^-?\d{1,8}(\.\d{1,2})?$/),
            })
            .parse(req.body),
          s = await shiftForUpdate(sql, paramsId(req));
        if (!s.user_id || s.status === "cancelled")
          fail(
            "INVALID_SHIFT",
            "Корректировка доступна для назначенной неотменённой смены",
          );
        const old = (
          await sql.query(
            "SELECT COALESCE(sum(minutes),0)::integer AS minutes,COALESCE(sum(amount),0)::text AS amount FROM adjustments WHERE shift_id=$1 AND user_id=$2",
            [s.id, s.user_id],
          )
        )[0];
        const minutes =
          Math.round(
            (new Date(s.end_at).getTime() - new Date(s.start_at).getTime()) /
              60000,
          ) +
          old.minutes +
          b.minutes;
        if (minutes < 0)
          fail("NEGATIVE_HOURS", "Итоговые часы не могут быть отрицательными");
        const check = (
          await sql.query(
            "SELECT CASE WHEN $1='shift' THEN $2::numeric ELSE round($3::numeric*$2::numeric/60,2) END+$4::numeric+$5::numeric AS amount,(CASE WHEN $1='shift' THEN $2::numeric ELSE round($3::numeric*$2::numeric/60,2) END+$5::numeric)-(CASE WHEN $1='shift' THEN $2::numeric ELSE round($6::numeric*$2::numeric/60,2) END) AS credit_amount",
            [s.pay_type, s.rate, minutes, old.amount, b.amount, minutes - b.minutes],
          )
        )[0];
        if (Number(check.amount) < 0)
          fail("NEGATIVE_AMOUNT", "Итоговая сумма не может быть отрицательной");
        const id = uid();
        await sql.query(
          "INSERT INTO adjustments(id,shift_id,user_id,minutes,amount,reason,created_by,credit_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [id, s.id, s.user_id, b.minutes, b.amount, b.reason, req.user.id, check.credit_amount],
        );
        await closeListing(sql, s.id);
        await sql.query("UPDATE shifts SET version=version+1 WHERE id=$1", [
          s.id,
        ]);
        await audit(
          sql,
          req.user.id,
          "Часы и начисления скорректированы",
          "adjustment",
          id,
          null,
          b,
          b.reason,
        );
        await notify(
          sql,
          [s.user_id, ...(await admins(sql))],
          "Корректировка начислений",
          b.reason,
          "adjustments",
          "payroll",
        );
        return { id };
      }),
    true,
  );
  route("GET", "/adjustments", async (req) => {
    const q = req.query as any;
    const id = idSchema.parse(q.shift_id);
    return db.query(
      `SELECT a.id,a.user_id,beneficiary.name AS user_name,a.credit_amount::text,a.minutes,a.amount::text,a.reason,a.created_at,u.name AS author FROM adjustments a JOIN users u ON u.id=a.created_by JOIN users beneficiary ON beneficiary.id=a.user_id WHERE a.shift_id=$1 ${req.user.role === "admin" ? "" : "AND a.user_id=$2"} ORDER BY a.created_at`,
      req.user.role === "admin" ? [id] : [id, req.user.id],
    );
  });
  route("PATCH", "/adjustments/:id/credit", (req) => db.tx(async (sql) => {
    const id = paramsId(req), body = reasonSchema.extend({ amount: z.string().regex(/^-?\d{1,8}(\.\d{1,2})?$/) }).parse(req.body);
    const candidate = (await sql.query("SELECT shift_id FROM adjustments WHERE id=$1", [id]))[0];
    if (!candidate) fail("NOT_FOUND", "Корректировка не найдена", 404);
    const shift = await shiftForUpdate(sql, candidate.shift_id);
    const row = (await sql.query("SELECT * FROM adjustments WHERE id=$1 FOR UPDATE", [id]))[0];
    if (row.credit_amount !== null || row.user_id === shift.user_id) fail("ALREADY_RECONCILED", "Эта корректировка не требует уточнения", 409);
    await sql.query("UPDATE adjustments SET credit_amount=$1 WHERE id=$2", [body.amount, id]);
    await sql.query("UPDATE shifts SET version=version+1 WHERE id=$1", [shift.id]);
    await audit(sql, req.user.id, "Сумма старой персональной корректировки уточнена", "adjustment", id, { credit_amount: null }, { credit_amount: body.amount }, body.reason);
    return { ok: true };
  }), true);
  async function payroll(req: FastifyRequest, own = false) {
    const [from, to] = range(req);
    const user = own ? req.user.id : (req.query as any).user_id;
    if (user) idSchema.parse(user);
    return payrollRows(db, from, to, user, await time(db));
  }
  route("GET", "/me/payroll", (req) => payroll(req, true));
  route("GET", "/payroll", (req) => payroll(req), true);
  route("GET", "/notifications", async (req) =>
    (await db.query(
      "SELECT id,title,body,category,link,read_at,created_at FROM notifications WHERE user_id=$1 AND NOT (category='admin' AND link IN ('employees','types') AND title IN ('Новый сотрудник','Команда обновлена','Типы смен обновлены')) ORDER BY created_at DESC LIMIT 200",
      [req.user.id],
    )).map((notice) => ({ ...notice, body: notificationText(notice.body) })),
  );
  route("POST", "/notifications/read", async (req) => {
    await db.query(
      "UPDATE notifications SET read_at=clock_timestamp() WHERE user_id=$1 AND read_at IS NULL",
      [req.user.id],
    );
    return { ok: true };
  });
  route(
    "POST",
    "/admin/notifications",
    (req) =>
      db.tx(async (sql) => {
        const b = z
          .object({
            title: text,
            body: z.string().min(1).max(1000),
            user_id: idSchema.nullable(),
          })
          .parse(req.body);
        const ids = b.user_id
          ? [b.user_id]
          : (await sql.query("SELECT id FROM users WHERE active")).map(
              (u) => u.id,
            );
        await notify(sql, ids, b.title, b.body, "admin", "notifications");
        await audit(
          sql,
          req.user.id,
          "Сообщение отправлено",
          "notification",
          null,
          null,
          { recipients: ids.length, title: b.title },
        );
        return { ok: true };
      }),
    true,
  );
  const defaultPrefs = {
    schedule: true,
    exchange: true,
    adjustments: true,
    admin: true,
    reminder_120: true,
    reminder_60: false,
  };
  route(
    "GET",
    "/me/preferences",
    async (req) =>
      (
        await db.query(
          "SELECT schedule,exchange,adjustments,admin,reminder_120,reminder_60 FROM preferences WHERE user_id=$1",
          [req.user.id],
        )
      )[0] ?? defaultPrefs,
  );
  route("PATCH", "/me/preferences", async (req) => {
    const b = z
      .object({
        schedule: z.boolean(),
        exchange: z.boolean(),
        adjustments: z.boolean(),
        admin: z.boolean(),
        reminder_120: z.boolean(),
        reminder_60: z.boolean(),
      })
      .parse(req.body);
    await db.query(
      "INSERT INTO preferences(user_id,schedule,exchange,adjustments,admin,reminder_120,reminder_60) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET schedule=$2,exchange=$3,adjustments=$4,admin=$5,reminder_120=$6,reminder_60=$7",
      [
        req.user.id,
        b.schedule,
        b.exchange,
        b.adjustments,
        b.admin,
        b.reminder_120,
        b.reminder_60,
      ],
    );
    return b;
  });
  route("POST", "/me/push-devices", async (req) => {
    const b = z.object({
      token: z.string().min(20).max(4096),
      platform: z.enum(["web", "android"]).default("web"),
      user_id: idSchema.optional(),
    }).parse(req.body);
    if (b.user_id && b.user_id !== req.user.id) fail("FORBIDDEN", "Аккаунт изменился. Включите уведомления заново", 403);
    if (!platformPushReady(await push.settings(), b.platform))
      fail(
        "PUSH_NOT_CONFIGURED",
        "Доставка уведомлений ещё не настроена администратором",
        409,
      );
    const device = await db.tx(async (sql) => {
      if (!(await sql.query("SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE", [req.session.id, req.user.id])).length)
        fail("UNAUTHORIZED", "Сессия истекла. Войдите снова", 401);
      await sql.query("DELETE FROM push_devices WHERE token=$1 AND (user_id<>$2 OR session_id<>$3)", [b.token, req.user.id, req.session.id]);
      return (await sql.query(
        "INSERT INTO push_devices(id,user_id,token,platform,session_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(token) DO UPDATE SET platform=$4 RETURNING id",
        [uid(), req.user.id, b.token, b.platform, req.session.id],
      ))[0];
    });
    return { id: device.id };
  });
  route("GET", "/me/push-status", async (req) => {
    const settings = await push.settings(),
      id = (req.query as any).device_id;
    const device = id
      ? (
          await db.query(
            "SELECT id,platform FROM push_devices WHERE id=$1 AND user_id=$2 AND session_id=$3",
            [idSchema.parse(id), req.user.id, req.session.id],
          )
        )[0]
      : null;
    return {
      configured: platformPushReady(settings, device?.platform ?? ((req.query as any).platform === "android" ? "android" : "web")),
      registered: !!device,
      device_id: device?.id ?? null,
    };
  });
  route(
    "GET",
    "/admin/push-status",
    async () => {
      const settings = await push.settings();
      const counts = (
        await db.query(
          "SELECT count(*) FILTER(WHERE sent_at IS NOT NULL)::integer AS accepted,count(*) FILTER(WHERE sent_at IS NULL AND attempts<8)::integer AS pending,count(*) FILTER(WHERE sent_at IS NULL AND attempts>=8)::integer AS failed FROM deliveries",
        )
      )[0];
      return {
        configured: settings.ready,
        android_configured: platformPushReady(settings, "android"),
        web_configured: platformPushReady(settings, "web"),
        status: settings.status,
        issues: settings.issues,
        project_id: settings.projectId ?? settings.config?.projectId ?? null,
        origin: settings.origin,
        ...counts,
      };
    },
    true,
  );
  route("POST", "/me/push-test", async (req) => {
    await consumeBudget(db, budgetKey("push-test", req.user.id), 3, 5 * 60000);
    const b = z.object({ device_id: idSchema }).parse(req.body);
    const device = (
      await db.query(
        "SELECT p.id,p.token,p.platform FROM push_devices p JOIN sessions s ON s.id=p.session_id AND s.user_id=p.user_id WHERE p.id=$1 AND p.user_id=$2 AND p.session_id=$3 AND s.expires_at>clock_timestamp()",
        [b.device_id, req.user.id, req.session.id],
      )
    )[0];
    if (!device)
      fail("DEVICE_NOT_FOUND", "Сначала включите push на этом устройстве", 404);
    if (!platformPushReady(await push.settings(), device.platform))
      fail(
        "PUSH_NOT_CONFIGURED",
        "Доставка уведомлений ещё не настроена администратором",
        409,
      );
    const id = uid(),
      title = "Тестовое уведомление RCS",
      body =
        "Тест доставки уведомлений RCS. Откройте приложение, чтобы вернуться к графику.";
    try {
      await push.send({
        token: device.token,
        platform: device.platform,
        title,
        body,
        link: "notifications",
        id,
      });
    } catch (e) {
      if (invalidPushToken(e)) {
        await db.query("DELETE FROM push_devices WHERE id=$1", [device.id]);
        fail(
          "PUSH_DEVICE_EXPIRED",
          "Подписка устарела. Включите push заново",
          410,
        );
      }
      fail(
        "PUSH_DELIVERY_FAILED",
        "Firebase не принял уведомление. Проверьте настройку доставки и повторите попытку",
        503,
      );
    }
    await db.tx(async (sql) => {
      await sql.query(
        "INSERT INTO notifications(id,user_id,title,body,category,link) VALUES($1,$2,$3,$4,'admin','notifications')",
        [id, req.user.id, title, body],
      );
      await sql.query(
        "INSERT INTO deliveries(id,notification_id,device_id,attempts,sent_at) VALUES($1,$2,$3,1,clock_timestamp())",
        [uid(), id, device.id],
      );
      await sql.query("INSERT INTO events DEFAULT VALUES");
    });
    return { accepted: true };
  });
  route("DELETE", "/me/push-devices", async (req) => {
    const b = z.object({ id: idSchema }).parse(req.body);
    await db.query("DELETE FROM push_devices WHERE user_id=$1 AND id=$2", [
      req.user.id,
      b.id,
    ]);
    return { ok: true };
  });
  route(
    "GET",
    "/audit-logs",
    async (req) => {
      const page = z.coerce
        .number()
        .int()
        .min(0)
        .max(10000)
        .parse((req.query as any).page ?? 0);
      return db.query(
        "SELECT a.*,u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 100 OFFSET $1",
        [page * 100],
      );
    },
    true,
  );
  const streams = new StreamHub(db);
  route("GET", "/events", async (req, reply) => {
    streams.assertCapacity(req.user.id);
    req.releaseCapacity?.();
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 3000\n\n");
    streams.add(req.user.id, req.session.id, reply.raw);
  });
  app.addHook("preClose", async () => {
    streams.close();
  });
  return app;
}
