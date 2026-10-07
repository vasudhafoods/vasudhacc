import "server-only";
import { and, desc, eq, sum } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventoryBalances, inventoryBatches, inventoryTransactionLines, inventoryTransactions, products, warehouseLocations } from "@/db/schema";
import { LOW_STOCK_THRESHOLD } from "@/lib/constants/inventory";
import type { PhysicalInventoryMovement, PhysicalInventoryProduct } from "@/types/physical-inventory";
import type { InventoryStatus } from "@/types/inventory";
import { isPhysicalUnitProduct, physicalUnitDisplayName } from "@/lib/inventory/physical-units";

function stockStatus(actual: number): InventoryStatus {
  if (actual <= 0) return "out-of-stock";
  if (actual < 100) return "low-stock";
  return "in-stock";
}

function buildProduct(rows: {
  id: string;
  sku: string;
  name: string;
  packSize: string | null;
  category: "noodles" | "cookies" | "rte" | "other";
  unitPricePaisa: number;
  bucket: "online" | "retail" | "buffer" | "qc" | "damaged";
  onHand: number;
  updatedAt: Date;
  locationName: string;
  expiryDate: Date | null;
}[]): PhysicalInventoryProduct {
  const first = rows[0];
  const buckets = { online: 0, retail: 0, buffer: 0, qc: 0, damaged: 0 };
  for (const row of rows) buckets[row.bucket] += row.onHand;
  const actual = buckets.online + buckets.retail + buckets.buffer + buckets.qc;
  const stockValuePaisa = actual * first.unitPricePaisa;
  const expiryDate = rows.filter((row) => row.expiryDate && row.onHand > 0).sort((left, right) => left.expiryDate!.getTime() - right.expiryDate!.getTime())[0]?.expiryDate ?? null;
  const latest = rows.reduce((value, row) => row.updatedAt > value ? row.updatedAt : value, first.updatedAt);
  return {
    id: first.id,
    sku: first.sku,
    name: first.name,
    displayName: physicalUnitDisplayName(first.name),
    packSize: first.packSize,
    category: first.category,
    unitPricePaisa: first.unitPricePaisa,
    locations: [...new Set(rows.map((row) => row.locationName))].sort((left, right) => left.localeCompare(right)),
    ...buckets,
    actual,
    stockValuePaisa,
    earliestExpiryDate: expiryDate?.toISOString() ?? null,
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
    category: products.category,
    unitPricePaisa: products.unitPricePaisa,
    bucket: inventoryBalances.bucket,
    onHand: inventoryBalances.onHand,
    updatedAt: inventoryBalances.updatedAt,
    locationName: warehouseLocations.name,
  }).from(products)
    .innerJoin(inventoryBalances, eq(inventoryBalances.productId, products.id))
    .innerJoin(warehouseLocations, eq(warehouseLocations.id, inventoryBalances.warehouseLocationId))
    .where(and(eq(products.active, true), eq(warehouseLocations.active, true)))
    .orderBy(products.name, products.sku);

  const batchRows = await getDatabase().select({ productId: inventoryBatches.productId, expiryDate: inventoryBatches.expiryDate, onHand: sum(inventoryTransactionLines.quantityDelta) }).from(inventoryBatches)
    .leftJoin(inventoryTransactionLines, eq(inventoryTransactionLines.batchId, inventoryBatches.id))
    .groupBy(inventoryBatches.id, inventoryBatches.productId, inventoryBatches.expiryDate);
  const expiryByProduct = new Map<string, Date>();
  for (const batch of batchRows) if (batch.expiryDate && Number(batch.onHand ?? 0) > 0 && (!expiryByProduct.has(batch.productId) || batch.expiryDate < expiryByProduct.get(batch.productId)!)) expiryByProduct.set(batch.productId, batch.expiryDate);

  type InventoryRow = (typeof rows)[number] & { expiryDate: Date | null };
  const groups = new Map<string, InventoryRow[]>();
  for (const row of rows) {
    if (!isPhysicalUnitProduct(row.name)) continue;
    const current = groups.get(row.id) ?? [];
    current.push({ ...row, expiryDate: expiryByProduct.get(row.id) ?? null });
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
