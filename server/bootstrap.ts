import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { hash } from "@node-rs/argon2";
import { openDatabase } from "./db";
import { uid, phone, audit } from "./domain";
const db = await openDatabase();
try {
  if (
    (
      await db.query(
        "SELECT id FROM users WHERE role='admin' AND active LIMIT 1",
      )
    ).length
  )
    throw new Error(
      "Администратор уже существует. Создайте сотрудника через интерфейс.",
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const name = (await rl.question("Имя администратора: ")).trim();
  const number = phone(await rl.question("Телефон (+375…): "));
  const password =
    process.env.ADMIN_PASSWORD ??
    (await rl.question("Новый пароль (от 10 символов, ввод видимый): "));
  rl.close();
  if (!name || password.trim().length < 10 || password.length > 128)
    throw new Error("Имя обязательно, пароль — от 10 символов");
  const hashed = await hash(password),
    id = uid();
  await db.tx(async (sql) => {
    await sql.query(
      "INSERT INTO users(id,name,phone,password_hash,role) VALUES($1,$2,$3,$4,'admin')",
      [id, name, number, hashed],
    );
    await audit(sql, id, "Первый администратор создан", "user", id);
  });
  console.log("Администратор создан. Запустите npm run dev.");
} finally {
  await db.close();
}
