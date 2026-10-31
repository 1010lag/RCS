import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { hash } from "@node-rs/argon2";
import { openDatabase } from "./db";
import { uid, localDate, dateTime, notify, audit } from "./domain";
const db = await openDatabase();
try {
  if ((await db.query("SELECT id FROM users LIMIT 1")).length)
    throw new Error(
      "База уже содержит пользователей. Демо-данные создаются только в пустой базе.",
    );
  if (process.env.NODE_ENV === "production")
    throw new Error("Демо-данные запрещены в production");
  const password = `Rcs!${randomBytes(9).toString("base64url")}`,
    hashed = await hash(password);
  const names = [
    "Александр Волков",
    "Анна Смирнова",
    "Максим Ковалёв",
    "София Орлова",
    "Даниил Морозов",
    "Ева Соколова",
  ];
  const users = names.map((name, i) => ({
    id: uid(),
    name,
    phone: `+37529000000${i}`,
    role: i === 0 ? "admin" : "barista",
    rate: 12 + i * 0.5,
  }));
  const types = [
    { id: uid(), name: "Открытие", start: "08:00", end: "15:00", rate: 12 },
    { id: uid(), name: "Закрытие", start: "15:00", end: "22:00", rate: 12 },
    { id: uid(), name: "Полная смена", start: "09:00", end: "21:00", rate: 12 },
  ];
  const today = localDate(),
    base = Date.parse(today);
  const weekday = (new Date(base).getUTCDay() + 6) % 7;
  await db.tx(async (sql) => {
    for (const u of users)
      await sql.query(
        "INSERT INTO users(id,name,phone,password_hash,role,rate) VALUES($1,$2,$3,$4,$5,$6)",
        [u.id, u.name, u.phone, hashed, u.role, u.rate],
      );
    for (const t of types)
      await sql.query(
        "INSERT INTO shift_types(id,name,start_time,end_time,pay_type,rate) VALUES($1,$2,$3,$4,'hourly',$5)",
        [t.id, t.name, t.start, t.end, t.rate],
      );
    for (let offset = -weekday - 7; offset < 14 - weekday; offset++) {
      const date = new Date(base + offset * 86400000)
        .toISOString()
        .slice(0, 10);
      for (let j = 0; j < 3; j++) {
        if ((offset + j + 30) % 5 === 0) continue;
        const u = users[1 + ((offset + 30 + j) % 5)],
          t = types[j === 2 ? 0 : j];
        const start = j === 2 ? "10:00" : t.start,
          end = j === 2 ? "16:00" : t.end;
        const id = uid(),
          startAt = dateTime(date, start),
          endAt = dateTime(date, end);
        const worked = new Date(endAt) < new Date();
        await sql.query(
          "INSERT INTO shifts(id,date,start_at,end_at,type_id,user_id,status,pay_type,rate) VALUES($1,$2,$3,$4,$5,$6,$7,'hourly',$8)",
          [
            id,
            date,
            startAt,
            endAt,
            t.id,
            u.id,
            worked ? "worked" : "confirmed",
            u.rate,
          ],
        );
        if (offset > 0 && (offset + j) % 4 === 0) {
          const close = new Date(
            Math.min(Date.parse(startAt), Date.parse(`${date}T19:00:00+03:00`)),
          );
          await sql.query(
            "INSERT INTO exchange_listings(id,shift_id,listed_by,closes_at) VALUES($1,$2,$3,$4)",
            [uid(), id, u.id, close],
          );
        }
      }
    }
    await notify(
      sql,
      users.map((u) => u.id),
      "Добро пожаловать в RCS",
      "График команды уже здесь. Хорошей смены!",
      "admin",
      "schedule",
    );
    await audit(
      sql,
      users[0].id,
      "Демонстрационная команда создана",
      "user",
      null,
    );
  });
  await mkdir(".data", { recursive: true });
  await writeFile(
    ".data/demo-access.txt",
    `Локальные демо-аккаунты RCS\nПароль: ${password}\n${users.map((u) => `${u.role}: ${u.name} — ${u.phone}`).join("\n")}\n`,
  );
  console.log(
    "Демо-команда создана. Телефоны и случайный пароль: .data/demo-access.txt (файл исключён из Git).",
  );
} finally {
  await db.close();
}
