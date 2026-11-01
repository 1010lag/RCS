import { z } from "zod";
import type { Database, Sql } from "./db";

// Parents precede their dependents. Sessions and device bindings remain linked.
const tables = ["users", "sessions", "shift_types", "shifts", "exchange_listings", "adjustments", "notifications", "preferences", "push_devices", "deliveries", "audit_logs", "events", "idempotency", "request_limits"] as const;
const backupSchema = z.object({
  format: z.literal("rcs-database-v1"),
  createdAt: z.string(),
  tables: z.array(z.object({ name: z.enum(tables), columns: z.array(z.string()), rows: z.array(z.string()) })),
});
type Backup = z.infer<typeof backupSchema>;
async function columns(sql: Sql, table: string) {
  return (await sql.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).map(row => row.column_name as string);
}
export async function exportDatabase(db: Database): Promise<Backup> {
  return db.tx(async sql => {
    const backup: Backup = { format: "rcs-database-v1", createdAt: new Date().toISOString(), tables: [] };
    for (const table of tables) {
      // Raw JSON text preserves SQL dates, timestamp precision, numerics and bigint IDs.
      const rows = await sql.query(`SELECT row_to_json(t)::text AS record FROM "${table}" t ORDER BY row_to_json(t)::text`);
      backup.tables.push({ name: table, columns: await columns(sql, table), rows: rows.map(row => row.record) });
    }
    return backup;
  });
}
export async function importDatabase(db: Database, input: unknown) {
  const backup = backupSchema.parse(input);
  if (backup.tables.length !== tables.length || tables.some((name, index) => backup.tables[index]?.name !== name))
    throw new Error("Backup does not contain the expected ordered set of tables.");
  return db.tx(async sql => {
    for (const table of backup.tables) {
      if ((await sql.query(`SELECT 1 FROM "${table.name}" LIMIT 1`)).length)
        throw new Error(`Destination table ${table.name} is not empty; import was cancelled.`);
      const targetColumns = await columns(sql, table.name);
      if (JSON.stringify(targetColumns) !== JSON.stringify(table.columns))
        throw new Error(`Schema differs for ${table.name}; use the same app version for export and import.`);
    }
    const counts: Record<string, number> = {};
    for (const table of backup.tables) {
      for (let offset = 0; offset < table.rows.length; offset += 100) {
        const batch = table.rows.slice(offset, offset + 100);
        await sql.query(`INSERT INTO "${table.name}" SELECT * FROM json_populate_recordset(NULL::"${table.name}", $1::json)`, [`[${batch.join(",")}]`]);
      }
      const count = Number((await sql.query(`SELECT count(*)::text AS count FROM "${table.name}"`))[0].count);
      if (count !== table.rows.length) throw new Error(`Row count differs for ${table.name}; import was cancelled.`);
      counts[table.name] = count;
    }
    await sql.query("SELECT setval(pg_get_serial_sequence('events','id'), COALESCE(max(id),1), count(*)>0) FROM events");
    return counts;
  });
}
