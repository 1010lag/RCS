import "dotenv/config";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { openDatabase } from "./db";
import { createApp } from "./app";
import { startWorker, tick } from "./worker";
const db = await openDatabase();
const app = await createApp(db, { logger: true });
app.get("/download/rcs.apk", async (_req, reply) => {
  const apk = resolve(".data/apk/RCS.apk");
  if (!existsSync(apk))
    return reply.code(404).send({ message: "APK ещё не собран" });
  return reply
    .header("Content-Type", "application/vnd.android.package-archive")
    .header("Content-Disposition", 'attachment; filename="RCS.apk"')
    .send(createReadStream(apk));
});
if (existsSync("dist/index.html")) {
  await app.register(fastifyStatic, { root: resolve("dist") });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/")
      ? reply.code(404).send({ message: "Маршрут не найден" })
      : reply.sendFile("index.html"),
  );
}
await tick(db);
const stop = startWorker(db, (e) => app.log.error(e));
await app.listen({
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    stop();
    await app.close();
    await db.close();
    process.exit(0);
  });
