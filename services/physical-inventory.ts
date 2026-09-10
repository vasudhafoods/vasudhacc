import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventoryBalances, inventoryTransactionLines, inventoryTransactions, products, warehouseLocations } from "@/db/schema";
import { LOW_STOCK_THRESHOLD } from "@/lib/constants/inventory";
import type { PhysicalInventoryMovement, PhysicalInventoryProduct } from "@/types/physical-inventory";
import type { InventoryStatus } from "@/types/inventory";

function isSalesBundle(name: string): boolean {
  return /\b(combo|bundle|variety|bestsellers?|medley|box|delights|assorted)\b/i.test(name);
}

function displayName(name: string): string {
  return name.replace(/\s*[·|–—-]\s*pack\s+of\s+1\b.*$/i, "").trim() || name;
}

function stockStatus(actual: number): InventoryStatus {
  if (actual <= 0) return "out-of-stock";
  if (actual <= LOW_STOCK_THRESHOLD) return "low-stock";
  return "in-stock";
}

function buildProduct(rows: {
  id: string;
  sku: string;
  name: string;
  packSize: string | null;
  bucket: "online" | "retail" | "buffer" | "qc" | "damaged";
  onHand: number;
  updatedAt: Date;
  locationName: string;
}[]): PhysicalInventoryProduct {
  const first = rows[0];
  const buckets = { online: 0, retail: 0, buffer: 0, qc: 0, damaged: 0 };
  for (const row of rows) buckets[row.bucket] += row.onHand;
  const actual = buckets.online + buckets.retail + buckets.buffer + buckets.qc;
  const latest = rows.reduce((value, row) => row.updatedAt > value ? row.updatedAt : value, first.updatedAt);
  return {
    id: first.id,
    sku: first.sku,
    name: first.name,
    displayName: displayName(first.name),
    packSize: first.packSize,
    locations: [...new Set(rows.map((row) => row.locationName))].sort((left, right) => left.localeCompare(right)),
    ...buckets,
    actual,
    status: stockStatus(actual),
    updatedAt: latest.toISOString(),
  };
}

export async function getPhysicalInventoryProducts(): Promise<PhysicalInventoryProduct[]> {
  const rows = await getDatabase().select({
    id: products.id,
    sku: products.sku,
    name: products.name,
    packSize: products.packSize,
    bucket: inventoryBalances.bucket,
    onHand: inventoryBalances.onHand,
    updatedAt: inventoryBalances.updatedAt,
    locationName: warehouseLocations.name,
  }).from(products)
    .innerJoin(inventoryBalances, eq(inventoryBalances.productId, products.id))
    .innerJoin(warehouseLocations, eq(warehouseLocations.id, inventoryBalances.warehouseLocationId))
    .where(and(eq(products.active, true), eq(warehouseLocations.active, true)))
    .orderBy(products.name, products.sku);

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (isSalesBundle(row.name)) continue;
    const current = groups.get(row.id) ?? [];
    current.push(row);
    groups.set(row.id, current);
  }
  return [...groups.values()].map(buildProduct).sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function getPhysicalInventoryProduct(productId: string): Promise<PhysicalInventoryProduct | null> {
  const products = await getPhysicalInventoryProducts();
  return products.find((product) => product.id === productId) ?? null;
}

export async function getPhysicalInventoryMovements(productId: string): Promise<PhysicalInventoryMovement[]> {
  const rows = await getDatabase().select({
    id: inventoryTransactionLines.id,
    occurredAt: inventoryTransactions.occurredAt,
    type: inventoryTransactions.type,
    transactionNumber: inventoryTransactions.transactionNumber,
    referenceId: inventoryTransactions.referenceId,
    reason: inventoryTransactions.reason,
    locationName: warehouseLocations.name,
    bucket: inventoryTransactionLines.bucket,
    quantityDelta: inventoryTransactionLines.quantityDelta,
    closingBalance: inventoryTransactionLines.closingBalance,
  }).from(inventoryTransactionLines)
    .innerJoin(inventoryTransactions, eq(inventoryTransactions.id, inventoryTransactionLines.transactionId))
    .innerJoin(warehouseLocations, eq(warehouseLocations.id, inventoryTransactionLines.warehouseLocationId))
    .where(eq(inventoryTransactionLines.productId, productId))
    .orderBy(desc(inventoryTransactions.occurredAt))
    .limit(50);
  return rows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
}
