import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";
import { z, ZodError } from "zod";
import { prepareAvatar } from "./avatar";
import type { Database, Sql } from "./db";
import type { User } from "../shared/types";
import { firebasePush, invalidPushToken, type PushGateway } from "./push";
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
  shiftForUpdate,
  expectVersion,
  assertExchange,
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
});
const typeSchema = z.object({
  name: text,
  start_time: z.string(),
  end_time: z.string(),
  pay_type: z.enum(["hourly", "shift"]),
  rate: z.string(),
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
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 65536,
    trustProxy: process.env.NODE_ENV === "production",
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
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
  const range = (req: FastifyRequest) => {
    const q = req.query as any;
    return period(
      q.from ?? new Date().toISOString().slice(0, 10),
      q.to ?? new Date().toISOString().slice(0, 10),
    );
  };
  app.get("/api/health", async () => ({ ok: true }));
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (req, reply) => {
      originCheck(req);
      const body = z
        .object({ phone: z.string(), password: z.string().max(128) })
        .parse(req.body);
      const u = (
        await db.query("SELECT * FROM users WHERE phone=$1 AND active", [
          phone(body.phone),
        ])
      )[0];
      // Hash once for a missing user as well, so login timing does not identify accounts.
      const valid = u
        ? await verify(u.password_hash, body.password)
        : (await hash(body.password), false);
      if (!u || !valid)
        fail("LOGIN_FAILED", "Неверный телефон или пароль", 401);
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
      push_ready: settings.ready,
    };
  });
  route("POST", "/auth/logout", async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE id=$1", [req.session.id]);
    reply.clearCookie("rcs_session", { path: "/" });
    return { ok: true };
  });
  route("POST", "/auth/password", async (req) => {
    const b = z
      .object({ current: z.string(), password: z.string().min(10).max(128) })
      .parse(req.body);
    const u = (
      await db.query("SELECT password_hash FROM users WHERE id=$1", [
        req.user.id,
      ])
    )[0];
    if (!(await verify(u.password_hash, b.current)))
      fail("LOGIN_FAILED", "Текущий пароль неверен", 403);
    const hashed = await hash(b.password);
    await db.tx(async (sql) => {
      await sql.query(
        "UPDATE users SET password_hash=$1,must_change_password=false,version=version+1 WHERE id=$2",
        [hashed, req.user.id],
      );
      await sql.query("DELETE FROM sessions WHERE user_id=$1 AND id<>$2", [
        req.user.id,
        req.session.id,
      ]);
      await audit(sql, req.user.id, "Пароль изменён", "user", req.user.id);
    });
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
  route("PUT", "/me/avatar", async (req) => {
    const { image } = z.object({ image: z.string().max(360000).nullable() }).parse(req.body);
    const avatar = image === null ? null : await prepareAvatar(image);
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
        id = uid(),
        hashed = await hash(b.password);
      const clean = {
        ...b,
        phone: phone(b.phone),
        rate: b.rate === null ? null : money(b.rate),
      };
      return db.tx(async (sql) => {
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
        await notify(
          sql,
          await admins(sql),
          "Новый сотрудник",
          `${b.name} добавлен в команду`,
          "admin",
          "employees",
        );
        return publicUser(u);
      });
    },
    true,
  );
  route(
    "PATCH",
    "/employees/:id",
    async (req) => {
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
          })
          .parse(req.body);
      const newPasswordHash = b.password ? await hash(b.password) : null;
      return db.tx(async (sql) => {
        if (!b.active) {
          // Serialize administrator removals so two concurrent actions cannot remove all admins.
          await sql.query("SELECT id FROM users WHERE role='admin' AND active ORDER BY id FOR UPDATE");
        }
        const old = (
          await sql.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
        )[0];
        if (!old) fail("NOT_FOUND", "Сотрудник не найден", 404);
        expectVersion(old, b.version);
        if (newPasswordHash) {
          if (!b.active) fail("INACTIVE_USER", "Для смены пароля сначала восстановите сотрудника");
          await sql.query("UPDATE users SET password_hash=$1,must_change_password=$2 WHERE id=$3", [newPasswordHash, id !== req.user.id, id]);
          await sql.query("DELETE FROM sessions WHERE user_id=$1 AND id<>$2", [id, req.session.id]);
          await sql.query("DELETE FROM push_devices WHERE user_id=$1", [id]);
          await audit(sql, req.user.id, "Пароль сотрудника изменён", "user", id, null, { other_sessions_revoked: true }, b.reason);
        }
        if (!b.active) {
          if (old.role === "admin" && (await admins(sql)).length <= 1)
            fail("LAST_ADMIN", "Нельзя отключить последнего администратора");
          if (id === req.user.id)
            fail("SELF_DELETE", "Нельзя удалить свой аккаунт. Попросите другого администратора", 409);
          const assigned = await sql.query(
            "SELECT id,status FROM shifts WHERE user_id=$1 AND status NOT IN ('cancelled','worked','closed') AND end_at>$2 ORDER BY id FOR UPDATE",
            [id, await time(sql)],
          );
          for (const shift of assigned) {
            await sql.query(
              "UPDATE shifts SET status='cancelled',version=version+1,updated_at=clock_timestamp() WHERE id=$1",
              [shift.id],
            );
            await closeListing(sql, shift.id);
            await audit(sql, req.user.id, "Смена отменена при удалении сотрудника", "shift", shift.id,
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
        await notify(
          sql,
          await admins(sql),
          "Команда обновлена",
          `${b.name}: данные сотрудника изменены`,
          "admin",
          "employees",
        );
        return publicUser(u);
      });
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
        money(b.rate),
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
      await notify(
        sql,
        await admins(sql),
        "Типы смен обновлены",
        b.name,
        "admin",
        "types",
      );
      return { id };
    });
  }
  route("POST", "/shift-types", (req) => saveType(req), true);
  route("PATCH", "/shift-types/:id", (req) => saveType(req, true), true);
  route("GET", "/schedule", async (req) => {
    const [from, to] = range(req);
    return db.query(
      `SELECT ${shiftProjection} ${req.user.role === "admin" ? financeProjection : ""} ${shiftJoins} ${req.user.role === "admin" ? adjustmentJoin : ""} WHERE s.date BETWEEN $1 AND $2 AND (s.user_id IS NULL OR u.active) ORDER BY s.start_at,u.name`,
      [from, to],
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
    await notify(
      sql,
      [old?.user_id, b.user_id],
      old ? "Ваша смена изменена" : "Новая смена",
      `${b.date} · ${b.start_time}–${b.end_time}`,
      "schedule",
      `shift:${id}`,
    );
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
  route(
    "POST",
    "/schedule/repeat-week",
    (req) =>
      db.tx(async (sql) => {
        const b = z
          .object({ from: z.string(), to: z.string() })
          .parse(req.body);
        dateTime(b.from, "00:00");
        dateTime(b.to, "00:00");
        const delta = (Date.parse(b.to) - Date.parse(b.from)) / 86400000;
        if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 366)
          fail("INVALID_PERIOD", "Выберите другую неделю в пределах года");
        const rows = await sql.query(
          "SELECT *,date::text,to_char(start_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS start_time,to_char(end_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS end_time FROM shifts WHERE date >= $1::date AND date < $1::date+7 AND status<>'cancelled' ORDER BY start_at",
          [b.from],
        );
        for (const s of rows) {
          const date = new Date(Date.parse(s.date) + delta * 86400000)
            .toISOString()
            .slice(0, 10);
          await writeShift(sql, req.user.id, {
            date,
            start_time: s.start_time,
            end_time: s.end_time,
            type_id: s.type_id,
            user_id: s.user_id,
            status: "planned",
            comment: s.comment,
            exchange_locked: s.exchange_locked,
            rate_override: s.rate_override ? s.rate : null,
          });
        }
        return { count: rows.length };
      }),
    true,
  );
  route("GET", "/exchange", async (req) => {
    const q = req.query as any;
    const history = q.history === "true";
    return db.query(
      `SELECT l.id,l.shift_id,l.status,l.taken_by,tu.name AS taken_name,l.closes_at,s.date::text,to_char(s.start_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS start_time,to_char(s.end_at AT TIME ZONE 'Europe/Minsk','HH24:MI') AS end_time,t.name AS type_name,l.listed_by AS user_id,u.name AS user_name,s.version FROM exchange_listings l JOIN shifts s ON s.id=l.shift_id JOIN users u ON u.id=l.listed_by JOIN shift_types t ON t.id=s.type_id LEFT JOIN users tu ON tu.id=l.taken_by WHERE ${history ? (req.user.role === "admin" ? "true" : "(l.listed_by=$1 OR l.taken_by=$1)") : "l.status='open' AND l.closes_at>clock_timestamp() AND s.status NOT IN ('cancelled','closed','worked') AND NOT s.exchange_locked AND t.allow_exchange AND t.active"} ORDER BY s.start_at DESC LIMIT 200`,
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
      const team = (await sql.query("SELECT id FROM users WHERE active")).map(
        (x) => x.id,
      );
      await notify(
        sql,
        team,
        "Новая смена на бирже",
        `${s.date} · Посмотрите свободную смену`,
        "exchange",
        "exchange",
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
            "SELECT COALESCE(sum(minutes),0)::integer AS minutes,COALESCE(sum(amount),0)::text AS amount FROM adjustments WHERE shift_id=$1",
            [s.id],
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
            "SELECT CASE WHEN $1='shift' THEN $2::numeric ELSE round($3::numeric*$2::numeric/60,2) END+$4::numeric+$5::numeric AS amount",
            [s.pay_type, s.rate, minutes, old.amount, b.amount],
          )
        )[0];
        if (Number(check.amount) < 0)
          fail("NEGATIVE_AMOUNT", "Итоговая сумма не может быть отрицательной");
        const id = uid();
        await sql.query(
          "INSERT INTO adjustments(id,shift_id,user_id,minutes,amount,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, s.id, s.user_id, b.minutes, b.amount, b.reason, req.user.id],
        );
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
      `SELECT a.id,a.minutes,a.amount::text,a.reason,a.created_at,u.name AS author FROM adjustments a JOIN users u ON u.id=a.created_by WHERE a.shift_id=$1 ${req.user.role === "admin" ? "" : "AND a.user_id=$2"} ORDER BY a.created_at`,
      req.user.role === "admin" ? [id] : [id, req.user.id],
    );
  });
  async function payroll(req: FastifyRequest, own = false) {
    const [from, to] = range(req);
    const user = own ? req.user.id : (req.query as any).user_id;
    if (user) idSchema.parse(user);
    return db.query(
      `WITH totals AS (SELECT s.user_id,u.name,s.date,(EXTRACT(EPOCH FROM(s.end_at-s.start_at))/60+COALESCE(a.minutes,0))::integer AS minutes, CASE WHEN s.pay_type='shift' THEN s.rate ELSE round((EXTRACT(EPOCH FROM(s.end_at-s.start_at))/60+COALESCE(a.minutes,0))*s.rate/60,2) END+COALESCE(a.amount,0) AS amount,(s.end_at<=clock_timestamp() OR s.status IN ('worked','closed')) AS worked FROM shifts s JOIN users u ON u.id=s.user_id ${adjustmentJoin} WHERE s.date BETWEEN $1 AND $2 AND s.status<>'cancelled' ${user ? "AND s.user_id=$3" : ""}) SELECT user_id,name,date::text,COALESCE(sum(minutes) FILTER(WHERE worked),0)::integer AS minutes,COALESCE(sum(amount) FILTER(WHERE worked),0)::text AS amount,COALESCE(sum(minutes) FILTER(WHERE NOT worked),0)::integer AS planned_minutes,COALESCE(sum(amount) FILTER(WHERE NOT worked),0)::text AS planned_amount FROM totals GROUP BY user_id,name,date ORDER BY date DESC,name`,
      user ? [from, to, user] : [from, to],
    );
  }
  route("GET", "/me/payroll", (req) => payroll(req, true));
  route("GET", "/payroll", (req) => payroll(req), true);
  route("GET", "/notifications", (req) =>
    db.query(
      "SELECT id,title,body,category,link,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200",
      [req.user.id],
    ),
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
    if (!(await push.settings()).ready)
      fail(
        "PUSH_NOT_CONFIGURED",
        "Доставка уведомлений ещё не настроена администратором",
        409,
      );
    const b = z
      .object({
        token: z.string().min(20).max(4096),
        platform: z.enum(["web", "android"]).default("web"),
      })
      .parse(req.body);
    const [device] = await db.query(
      "INSERT INTO push_devices(id,user_id,token,platform) VALUES($1,$2,$3,$4) ON CONFLICT(token) DO UPDATE SET user_id=$2,platform=$4 RETURNING id",
      [uid(), req.user.id, b.token, b.platform],
    );
    return { id: device.id };
  });
  route("GET", "/me/push-status", async (req) => {
    const settings = await push.settings(),
      id = (req.query as any).device_id;
    const device = id
      ? (
          await db.query(
            "SELECT id FROM push_devices WHERE id=$1 AND user_id=$2",
            [idSchema.parse(id), req.user.id],
          )
        )[0]
      : null;
    return {
      configured: settings.ready,
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
        status: settings.status,
        issues: settings.issues,
        project_id: settings.config?.projectId ?? null,
        origin: settings.origin,
        ...counts,
      };
    },
    true,
  );
  route("POST", "/me/push-test", async (req) => {
    const b = z.object({ device_id: idSchema }).parse(req.body);
    const device = (
      await db.query(
        "SELECT id,token,platform FROM push_devices WHERE id=$1 AND user_id=$2",
        [b.device_id, req.user.id],
      )
    )[0];
    if (!device)
      fail("DEVICE_NOT_FOUND", "Сначала включите push на этом устройстве", 404);
    if (!(await push.settings()).ready)
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
  const streams = new Set<() => void>();
  route("GET", "/events", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 3000\n\n");
    let last = "";
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const valid = await db.query(
          "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>clock_timestamp() AND u.active",
          [req.session.id],
        );
        if (!valid.length) {
          reply.raw.write("event: revoked\ndata: {}\n\n");
          stop();
          return;
        }
        const current = (
          await db.query("SELECT COALESCE(max(id),0)::text AS id FROM events")
        )[0].id;
        if (current !== last) {
          last = current;
          reply.raw.write(
            `event: change\ndata: ${JSON.stringify({ revision: current })}\n\n`,
          );
        } else reply.raw.write(": heartbeat\n\n");
      } catch {
        stop();
      } finally {
        busy = false;
      }
    }, 1000);
    function stop() {
      clearInterval(timer);
      streams.delete(stop);
      reply.raw.end();
    }
    streams.add(stop);
    reply.raw.on("close", () => {
      clearInterval(timer);
      streams.delete(stop);
    });
  });
  app.addHook("preClose", async () => {
    for (const stop of streams) stop();
  });
  return app;
}
