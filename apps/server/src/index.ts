// Server entry point: load config, run migrations, build the app, listen.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { createSmtpMailer } from "./mailer.js";

// Resolve the migrations folder next to this module, so it works both from
// src (run with tsx) and from dist (run with node after a build).
const migrationsFolder = path.join(fileURLToPath(new URL(".", import.meta.url)), "../drizzle");

async function main() {
  const config = loadConfig();
  const db = createDbClient(config);

  await migrate(db, { migrationsFolder });

  const mailer = createSmtpMailer(config);
  const app = await buildApp({ config, db, mailer });

  // One failed background task must not stop the server for all users. Log the error and continue.
  process.on("unhandledRejection", (reason) => {
    app.log.error(reason, "A promise rejected and no code handled the error.");
  });

  await app.listen({ port: config.apiPort, host: "0.0.0.0" });
  app.log.info(`Server is ready. It listens on port ${config.apiPort}.`);

  const shutdown = async (signal: string) => {
    app.log.info(`Got ${signal}. The server is shutting down.`);
    await app.close();
    await db.$client.end();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("Server failed to start.", error);
  process.exit(1);
});
