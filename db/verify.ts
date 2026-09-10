import { loadEnvConfig } from "@next/env";
import postgres from "postgres";

loadEnvConfig(process.cwd());

function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is not configured.");
  return value;
}

async function main() {
  const client = postgres(getDatabaseUrl(), { max: 1, prepare: false });
  try {
    const [tableCount] = await client<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any(array[
          'products', 'shopify_mappings', 'warehouse_locations', 'inventory_batches',
          'inventory_balances', 'inventory_transactions', 'inventory_transaction_lines',
          'retail_recipients', 'integration_outbox', 'shopify_webhook_events',
          'audit_events', 'staff_users', 'offline_sales', 'offline_sale_collections', 'inventory_snapshots',
          'operations_settings', 'inventory_snapshot_runs'
        ])
    `;
    const locations = await client<{ code: string; name: string }[]>`
      select code, name from warehouse_locations order by code
    `;
    const [migrationCount] = await client<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `;
    const staffColumns = await client<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public'
        and table_name = 'staff_users'
        and column_name = any(array['password_hash', 'last_login_at'])
      order by column_name
    `;
    console.log(JSON.stringify({ expectedTables: tableCount.count, migrations: migrationCount.count, locations, staffLoginColumns: staffColumns.map((column) => column.column_name) }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database verification failed.");
  process.exitCode = 1;
});
