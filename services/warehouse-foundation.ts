import "server-only";
import { count, sql, sum } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { integrationOutbox, inventoryBalances, inventoryTransactions, products, shopifyMappings, shopifyWebhookEvents } from "@/db/schema";

export interface WarehouseFoundationStatus {
  configured: boolean;
  initialized: boolean;
  products: number;
  mappings: number;
  balances: number;
  transactions: number;
  pendingShopifyUpdates: number;
  failedShopifyWebhooks: number;
  onlineAllocation: number;
  retailStock: number;
  bufferStock: number;
  physicalStock: number;
  damagedStock: number;
  error: string | null;
}

export async function getWarehouseFoundationStatus(): Promise<WarehouseFoundationStatus> {
  const empty = { products: 0, mappings: 0, balances: 0, transactions: 0, pendingShopifyUpdates: 0, failedShopifyWebhooks: 0, onlineAllocation: 0, retailStock: 0, bufferStock: 0, physicalStock: 0, damagedStock: 0 };
  if (!process.env.DATABASE_URL?.trim()) return { configured: false, initialized: false, ...empty, error: "DATABASE_URL is not available in this runtime." };
  try {
    const db = getDatabase();
    await db.execute(sql`select 1`);
    const [[productCount], [mappingCount], [balanceCount], [transactionCount], [pendingCount], [failedWebhookCount], bucketRows] = await Promise.all([
      db.select({ value: count() }).from(products),
      db.select({ value: count() }).from(shopifyMappings),
      db.select({ value: count() }).from(inventoryBalances),
      db.select({ value: count() }).from(inventoryTransactions),
      db.select({ value: count() }).from(integrationOutbox).where(sql`${integrationOutbox.status} in ('pending', 'failed')`),
      db.select({ value: count() }).from(shopifyWebhookEvents).where(sql`${shopifyWebhookEvents.status} = 'failed'`),
      db.select({ bucket: inventoryBalances.bucket, value: sum(inventoryBalances.onHand) }).from(inventoryBalances).groupBy(inventoryBalances.bucket),
    ]);
    const stock = new Map(bucketRows.map((row) => [row.bucket, Number(row.value ?? 0)]));
    const onlineAllocation = stock.get("online") ?? 0;
    const retailStock = stock.get("retail") ?? 0;
    const bufferStock = stock.get("buffer") ?? 0;
    const qcStock = stock.get("qc") ?? 0;
    const damagedStock = stock.get("damaged") ?? 0;
    return { configured: true, initialized: true, products: productCount.value, mappings: mappingCount.value, balances: balanceCount.value, transactions: transactionCount.value, pendingShopifyUpdates: pendingCount.value, failedShopifyWebhooks: failedWebhookCount.value, onlineAllocation, retailStock, bufferStock, physicalStock: onlineAllocation + retailStock + bufferStock + qcStock, damagedStock, error: null };
  } catch (error) {
    return { configured: true, initialized: false, ...empty, error: error instanceof Error ? error.message : "The warehouse database could not be reached." };
  }
}
