import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openDatabase } from "../server/db";
import { exportDatabase, importDatabase } from "../server/database-transfer";

const [command, file, source] = process.argv.slice(2);
if (!file || !["export", "import"].includes(command)) throw new Error("Usage: tsx scripts/transfer-database.ts export BACKUP.json OFFLINE_PGLITE_DIRECTORY | import BACKUP.json (DATABASE_URL required)");
if (command === "export" && !source) throw new Error("Export requires an offline copy of the local database directory. Stop the local server before copying it.");
if (command === "import" && !process.env.DATABASE_URL) throw new Error("Import requires the destination PostgreSQL DATABASE_URL.");
const db = await openDatabase(command === "export" ? resolve(source!) : undefined);
try {
  if (command === "export") {
    const backup = await exportDatabase(db);
    await mkdir(dirname(resolve(file)), { recursive: true });
    await writeFile(file, JSON.stringify(backup), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ file: resolve(file), counts: Object.fromEntries(backup.tables.map(table => [table.name, table.rows.length])) }, null, 2));
  } else {
    const counts = await importDatabase(db, JSON.parse(await readFile(file, "utf8")));
    console.log(JSON.stringify({ imported: true, counts }, null, 2));
  }
} finally { await db.close(); }
