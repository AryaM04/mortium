// Drizzle Kit configuration, used to generate and run migrations.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://mortium:mortium@localhost:5432/mortium",
  },
});
