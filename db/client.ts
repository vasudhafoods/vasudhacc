import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is not configured. Pull the Neon environment variables from Vercel.");
  return value;
}

function createDatabase() {
  const client = postgres(databaseUrl(), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return drizzle({ client, schema });
}

let database: ReturnType<typeof createDatabase> | null = null;

export function getDatabase() {
  database ??= createDatabase();
  return database;
}
