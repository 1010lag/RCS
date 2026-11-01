export function hostedSettings(env: NodeJS.ProcessEnv) {
  if (!env.DATABASE_URL) throw new Error("Hosting requires DATABASE_URL: local PGlite storage is not persistent on a free web service.");
  const database = new URL(env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("DATABASE_URL must point to PostgreSQL.");
  const appOrigin = env.APP_ORIGIN || env.RENDER_EXTERNAL_URL;
  if (!appOrigin) throw new Error("Hosting requires APP_ORIGIN or RENDER_EXTERNAL_URL with the application's HTTPS origin.");
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("Hosting requires APP_ORIGIN with the application's HTTPS origin.");
  return { NODE_ENV: "production", HOST: env.HOST || "0.0.0.0", APP_ORIGIN: origin.origin, WORKER_IDLE_MS: env.WORKER_IDLE_MS || "3600000" };
}
