import { loadEnvConfig } from "@next/env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

loadEnvConfig(process.cwd());

function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is not configured.");
  return value;
}

const databaseUrl = getDatabaseUrl();

async function main() {
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    console.log("Database migrations completed.");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database migration failed.");
  process.exitCode = 1;
});
