// Makes sure a dedicated database exists for the auth e2e tests, so they
// never touch a person's real dev data. Connects to the "postgres"
// maintenance database to run CREATE DATABASE, the same pattern as
// apps/server/test/db.ts.
import postgres from "postgres";

export const E2E_DATABASE_NAME = "mortium_e2e";

export interface PostgresConnectionInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

export async function ensureE2eDatabase(info: PostgresConnectionInfo): Promise<void> {
  const adminUrl = `postgres://${info.user}:${info.password}@${info.host}:${info.port}/postgres`;
  const sql = postgres(adminUrl, { max: 1 });
  try {
    await sql.unsafe(`CREATE DATABASE ${E2E_DATABASE_NAME}`);
  } catch (error) {
    // 42P04 = duplicate_database. The database already exists, which is
    // the normal case on every run after the first.
    if ((error as { code?: string }).code !== "42P04") {
      throw error;
    }
  } finally {
    await sql.end();
  }
}
