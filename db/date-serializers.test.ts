import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { installDateSerializers, serializeDateParam } from "./date-serializers";

test("raw Date parameters serialize to ISO strings", () => {
  assert.equal(serializeDateParam(new Date("2026-10-09T16:15:19.000Z")), "2026-10-09T16:15:19.000Z");
  assert.equal(serializeDateParam("2026-10-09 16:15:19+00"), "2026-10-09 16:15:19+00");
});

test("date serializers survive drizzle's pass-through override", async () => {
  const client = postgres("postgres://localhost/unused", { prepare: false });
  drizzle({ client });
  installDateSerializers(client);
  assert.equal(client.options.serializers[1184](new Date(0)), "1970-01-01T00:00:00.000Z");
  await client.end();
});
