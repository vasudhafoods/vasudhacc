import type { Sql } from "postgres";

// Drizzle replaces postgres-js date serializers with pass-through functions, so a raw Date
// interpolated into a sql`` template crashes the query. Typed columns already arrive as strings.
const DATE_TYPES = [1082, 1083, 1114, 1182, 1184, 1185, 1115, 1231];

export function serializeDateParam(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

export function installDateSerializers(client: Sql): void {
  for (const type of DATE_TYPES) client.options.serializers[type] = serializeDateParam;
}
