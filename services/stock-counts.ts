import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import {
  auditEvents,
  integrationOutbox,
  inventoryBalances,
  inventoryTransactionLines,
  inventoryTransactions,
  products,
  shopifyMappings,
  warehouseLocations,
} from "@/db/schema";
import { receiptAllocation } from "@/lib/inventory/allocation";
import { isPhysicalUnitProduct } from "@/lib/inventory/physical-units";

export interface PhysicalStockCountLine {
  productId: string;
  warehouseLocationId: string;
  quantity: number;
}

export interface PhysicalStockCountInput {
  lines: PhysicalStockCountLine[];
  actorUsername: string;
  reason: string;
  idempotencyKey: string;
}

export interface PhysicalStockCountResult {
  productId: string;
  productName: string;
  requestedQuantity: number;
  online: number;
  retail: number;
  buffer: number;
  issue?: string;
}

export class PhysicalStockCountError extends Error {
  constructor(readonly code: "INVALID_COUNT" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "PhysicalStockCountError";
  }
}

function validate(input: PhysicalStockCountInput) {
  if (!input.lines.length || input.lines.length > 100) throw new PhysicalStockCountError("INVALID_COUNT", "Submit between 1 and 100 physical stock counts.");
  if (!input.actorUsername.trim() || !input.reason.trim() || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new PhysicalStockCountError("INVALID_COUNT", "Actor, reason, and a valid idempotency key are required.");
  }
  const scopes = new Set<string>();
  for (const line of input.lines) {
    if (!line.productId.trim() || !line.warehouseLocationId.trim() || !Number.isSafeInteger(line.quantity) || line.quantity < 0) {
      throw new PhysicalStockCountError("INVALID_COUNT", "Each count needs a product, warehouse, and non-negative whole-unit quantity.");
    }
    const scope = `${line.productId}:${line.warehouseLocationId}`;
    if (scopes.has(scope)) throw new PhysicalStockCountError("INVALID_COUNT", "Each product and warehouse can appear only once in a stock count.");
    scopes.add(scope);
  }
}

function reserveAwareAllocation(quantity: number, reserved: Record<"online" | "retail" | "buffer", number>) {
  const committed = reserved.online + reserved.retail + reserved.buffer;
  if (committed > quantity) return null;
  const free = receiptAllocation(quantity - committed);
  return { online: reserved.online + free.online, retail: reserved.retail + free.retail, buffer: reserved.buffer + free.buffer };
}

export async function applyPhysicalStockCount(input: PhysicalStockCountInput) {
  validate(input);
  const db = getDatabase();
  const [existing] = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber, metadata: inventoryTransactions.metadata })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) {
    return {
      transactionId: existing.id,
      transactionNumber: existing.transactionNumber,
      duplicate: true,
      results: Array.isArray(existing.metadata.stockCounts) ? existing.metadata.stockCounts as PhysicalStockCountResult[] : [],
    };
  }

  return db.transaction(async (tx) => {
    const productIds = [...new Set(input.lines.map((line) => line.productId))];
    const locationIds = [...new Set(input.lines.map((line) => line.warehouseLocationId))];
    const [productRows, locationRows] = await Promise.all([
      tx.select({ id: products.id, name: products.name, active: products.active }).from(products).where(inArray(products.id, productIds)),
      tx.select({ id: warehouseLocations.id, active: warehouseLocations.active }).from(warehouseLocations).where(inArray(warehouseLocations.id, locationIds)),
    ]);
    const productById = new Map(productRows.map((product) => [product.id, product]));
    const activeLocations = new Set(locationRows.filter((location) => location.active).map((location) => location.id));
    for (const line of input.lines) {
      const product = productById.get(line.productId);
      if (!product || !product.active || !isPhysicalUnitProduct(product.name)) throw new PhysicalStockCountError("NOT_FOUND", "A selected product is inactive or is not an individual physical-unit product.");
      if (!activeLocations.has(line.warehouseLocationId)) throw new PhysicalStockCountError("NOT_FOUND", "A selected warehouse is inactive or could not be found.");
    }

    await tx.insert(inventoryBalances).values(input.lines.flatMap((line) => ([
      { productId: line.productId, warehouseLocationId: line.warehouseLocationId, bucket: "online" as const },
      { productId: line.productId, warehouseLocationId: line.warehouseLocationId, bucket: "retail" as const },
      { productId: line.productId, warehouseLocationId: line.warehouseLocationId, bucket: "buffer" as const },
    ]))).onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });

    const balances = await tx.select().from(inventoryBalances).where(and(
      inArray(inventoryBalances.productId, productIds),
      inArray(inventoryBalances.warehouseLocationId, locationIds),
      inArray(inventoryBalances.bucket, ["online", "retail", "buffer"]),
    )).orderBy(inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket).for("update");
    const balancesByScope = new Map<string, typeof balances>();
    for (const balance of balances) {
      const key = `${balance.productId}:${balance.warehouseLocationId}`;
      balancesByScope.set(key, [...(balancesByScope.get(key) ?? []), balance]);
    }

    const results: PhysicalStockCountResult[] = [];
    const changed: { line: PhysicalStockCountLine; allocation: { online: number; retail: number; buffer: number }; balances: typeof balances }[] = [];
    for (const line of input.lines) {
      const product = productById.get(line.productId)!;
      const scopedBalances = balancesByScope.get(`${line.productId}:${line.warehouseLocationId}`) ?? [];
      const byBucket = new Map(scopedBalances.map((balance) => [balance.bucket, balance]));
      const reserved = {
        online: byBucket.get("online")?.reserved ?? 0,
        retail: byBucket.get("retail")?.reserved ?? 0,
        buffer: byBucket.get("buffer")?.reserved ?? 0,
      };
      const committed = reserved.online + reserved.retail + reserved.buffer;
      const appliedQuantity = Math.max(line.quantity, committed);
      const allocation = reserveAwareAllocation(appliedQuantity, reserved);
      if (!allocation) {
        results.push({ productId: line.productId, productName: product.name, requestedQuantity: line.quantity, online: byBucket.get("online")?.onHand ?? 0, retail: byBucket.get("retail")?.onHand ?? 0, buffer: byBucket.get("buffer")?.onHand ?? 0, issue: `Cannot count ${line.quantity} units while ${reserved.online + reserved.retail + reserved.buffer} units remain committed to open orders.` });
        continue;
      }
      results.push({
        productId: line.productId,
        productName: product.name,
        requestedQuantity: line.quantity,
        ...allocation,
        ...(appliedQuantity > line.quantity ? { issue: `Kept ${committed} units reserved for an open order; Online availability is set to ${allocation.online}.` } : {}),
      });
      changed.push({ line, allocation, balances: scopedBalances });
    }

    if (!changed.length) return { transactionId: null, transactionNumber: null, duplicate: false, results };
    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: "cycle_count_adjustment",
      idempotencyKey: input.idempotencyKey,
      actorUsername: input.actorUsername,
      reason: input.reason,
      metadata: { action: "physical_stock_count_40_40_20", unit: "individual_packet", stockCounts: results },
    }).returning({ id: inventoryTransactions.id });

    const transactionLines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
    const previousValue: Record<string, number> = {};
    const newValue: Record<string, number> = {};
    for (const entry of changed) {
      const key = `${entry.line.productId}:${entry.line.warehouseLocationId}`;
      const byBucket = new Map(entry.balances.map((balance) => [balance.bucket, balance]));
      for (const bucket of ["online", "retail", "buffer"] as const) {
        const balance = byBucket.get(bucket)!;
        const closingBalance = entry.allocation[bucket];
        const quantityDelta = closingBalance - balance.onHand;
        if (quantityDelta === 0) continue;
        await tx.update(inventoryBalances).set({ onHand: closingBalance, version: sql`${inventoryBalances.version} + 1` }).where(eq(inventoryBalances.id, balance.id));
        transactionLines.push({ transactionId: transaction.id, productId: entry.line.productId, warehouseLocationId: entry.line.warehouseLocationId, bucket, quantityDelta, openingBalance: balance.onHand, closingBalance });
        previousValue[`${key}:${bucket}`] = balance.onHand;
        newValue[`${key}:${bucket}`] = closingBalance;
      }
    }
    if (transactionLines.length) await tx.insert(inventoryTransactionLines).values(transactionLines);

    const mappings = await tx.select().from(shopifyMappings).where(and(inArray(shopifyMappings.productId, changed.map((entry) => entry.line.productId)), eq(shopifyMappings.status, "mapped")));
    const mappingByProduct = new Map<string, typeof shopifyMappings.$inferSelect>();
    for (const mapping of mappings) if (!mappingByProduct.has(mapping.productId)) mappingByProduct.set(mapping.productId, mapping);
    const onlineTargets = changed.flatMap((entry) => {
      const mapping = mappingByProduct.get(entry.line.productId);
      return mapping ? [{ mapping, quantity: entry.allocation.online }] : [];
    });
    if (onlineTargets.length) {
      const itemIds = new Set(onlineTargets.map(({ mapping }) => mapping.shopifyInventoryItemId));
      const oldJobs = await tx.select({ id: integrationOutbox.id, payload: integrationOutbox.payload }).from(integrationOutbox).where(and(
        eq(integrationOutbox.operation, "shopify_inventory_adjust"),
        inArray(integrationOutbox.status, ["pending", "failed"]),
      ));
      const supersededIds = oldJobs.filter((job) => typeof job.payload.shopifyInventoryItemId === "string" && itemIds.has(job.payload.shopifyInventoryItemId)).map((job) => job.id);
      if (supersededIds.length) await tx.update(integrationOutbox).set({
        status: "cancelled",
        lockedAt: null,
        completedAt: new Date(),
        lastError: "Superseded by a physical stock count; a fresh absolute Online quantity was queued.",
        updatedAt: new Date(),
      }).where(inArray(integrationOutbox.id, supersededIds));
      await tx.insert(integrationOutbox).values(onlineTargets.map(({ mapping, quantity }, index) => ({
        transactionId: transaction.id,
        operation: "shopify_inventory_adjust",
        idempotencyKey: `${input.idempotencyKey}:shopify:${index}`,
        payload: { shopifyInventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, quantity, reason: "correction" },
      })));
    }

    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "inventory.physical_stock_count",
      entityType: "inventory_transaction",
      entityId: transaction.id,
      previousValue,
      newValue,
      reason: input.reason,
    });
    return { transactionId: transaction.id, transactionNumber, duplicate: false, results };
  }, { isolationLevel: "serializable" });
}
