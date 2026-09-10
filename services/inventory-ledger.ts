import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import {
  auditEvents,
  integrationOutbox,
  inventoryBalances,
  inventoryBatches,
  inventoryTransactionLines,
  inventoryTransactions,
  products,
  shopifyMappings,
  type InventoryBucket,
} from "@/db/schema";
import type { ShopifySyncStatus } from "@/types/warehouse";

export class InventoryCommandError extends Error {
  constructor(readonly code: "INVALID_TRANSFER" | "INVALID_RECEIPT" | "INVALID_DISPATCH" | "INSUFFICIENT_STOCK" | "MAPPING_REQUIRED" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "InventoryCommandError";
  }
}

export interface ReceiveStockInput {
  productId: string;
  warehouseLocationId: string;
  receivedQuantity: number;
  damagedQuantity: number;
  onlineQuantity: number;
  retailQuantity: number;
  bufferQuantity: number;
  batchNumber: string;
  manufacturingDate?: Date;
  expiryDate?: Date;
  actorUsername: string;
  reason: string;
  source: string;
  idempotencyKey: string;
  shopifyMappingId?: string;
  referenceId?: string;
}

export interface ReceiveStockResult {
  transactionId: string;
  transactionNumber: string;
  duplicate: boolean;
  receivedQuantity: number;
  shopifySync: ShopifySyncStatus;
}

export interface TransferInventoryInput {
  productId: string;
  warehouseLocationId: string;
  fromBucket: InventoryBucket;
  toBucket: InventoryBucket;
  quantity: number;
  actorUsername: string;
  reason: string;
  idempotencyKey: string;
  shopifyMappingId?: string;
  referenceId?: string;
}

export interface TransferInventoryResult {
  transactionId: string;
  transactionNumber: string;
  duplicate: boolean;
  fromClosingBalance: number;
  toClosingBalance: number;
  shopifySync: ShopifySyncStatus;
}

export interface RetailDispatchInput {
  warehouseLocationId: string;
  lines: { productId: string; quantity: number }[];
  destination: string;
  referenceId: string;
  notes?: string;
  actorUsername: string;
  idempotencyKey: string;
}

export interface RetailDispatchResult {
  transactionId: string;
  transactionNumber: string;
  duplicate: boolean;
  totalQuantity: number;
  destination: string;
  lines: { productId: string; productName: string; sku: string; quantity: number; closingRetailBalance: number }[];
}

function validateTransfer(input: TransferInventoryInput) {
  if (input.fromBucket === input.toBucket) throw new InventoryCommandError("INVALID_TRANSFER", "Source and destination buckets must differ.");
  if (input.fromBucket === "online") throw new InventoryCommandError("INVALID_TRANSFER", "Moving stock out of Online is disabled until Shopify committed inventory is synchronized.");
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new InventoryCommandError("INVALID_TRANSFER", "Quantity must be a positive whole number.");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new InventoryCommandError("INVALID_TRANSFER", "A valid idempotency key is required.");
  if (!input.actorUsername.trim() || !input.reason.trim()) throw new InventoryCommandError("INVALID_TRANSFER", "Actor and reason are required.");
  if (input.toBucket === "online" && !input.shopifyMappingId) {
    throw new InventoryCommandError("MAPPING_REQUIRED", "A verified Shopify mapping is required for Online transfers.");
  }
}

function validateReceipt(input: ReceiveStockInput) {
  const quantities = [input.receivedQuantity, input.damagedQuantity, input.onlineQuantity, input.retailQuantity, input.bufferQuantity];
  if (quantities.some((quantity) => !Number.isSafeInteger(quantity) || quantity < 0) || input.receivedQuantity <= 0) {
    throw new InventoryCommandError("INVALID_RECEIPT", "Receipt quantities must be non-negative whole numbers and received quantity must be positive.");
  }
  if (input.onlineQuantity + input.retailQuantity + input.bufferQuantity + input.damagedQuantity !== input.receivedQuantity) {
    throw new InventoryCommandError("INVALID_RECEIPT", "Online, Retail, Buffer and Damaged allocation must equal the received quantity.");
  }
  if (!input.batchNumber.trim() || !input.source.trim() || !input.reason.trim() || !input.actorUsername.trim() || !input.idempotencyKey.trim()) {
    throw new InventoryCommandError("INVALID_RECEIPT", "Batch, source, reason, actor and idempotency key are required.");
  }
  if (input.onlineQuantity > 0 && !input.shopifyMappingId) {
    throw new InventoryCommandError("MAPPING_REQUIRED", "A verified Shopify mapping is required when received stock is allocated Online.");
  }
}

function validateRetailDispatch(input: RetailDispatchInput) {
  if (!input.warehouseLocationId.trim()) throw new InventoryCommandError("INVALID_DISPATCH", "Select the warehouse dispatching this stock.");
  if (!input.destination.trim() || input.destination.trim().length > 200) throw new InventoryCommandError("INVALID_DISPATCH", "Enter a valid retail destination of 200 characters or fewer.");
  if (!input.referenceId.trim() || input.referenceId.trim().length > 100) throw new InventoryCommandError("INVALID_DISPATCH", "Enter an invoice, order, or dispatch reference of 100 characters or fewer.");
  if (!input.actorUsername.trim() || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new InventoryCommandError("INVALID_DISPATCH", "Actor and idempotency key are required.");
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) throw new InventoryCommandError("INVALID_DISPATCH", "Add between 1 and 50 products to the dispatch.");
  const productIds = new Set<string>();
  for (const line of input.lines) {
    if (!line.productId.trim() || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) throw new InventoryCommandError("INVALID_DISPATCH", "Every dispatch line needs a product and a positive whole-packet quantity.");
    if (productIds.has(line.productId)) throw new InventoryCommandError("INVALID_DISPATCH", "Add each product only once; update its quantity on the existing line.");
    productIds.add(line.productId);
  }
  if (input.notes && input.notes.trim().length > 500) throw new InventoryCommandError("INVALID_DISPATCH", "Dispatch notes must be 500 characters or fewer.");
}

async function readRetailDispatchResult(transactionId: string, transactionNumber: string, duplicate: boolean): Promise<RetailDispatchResult> {
  const db = getDatabase();
  const [transaction, lines] = await Promise.all([
    db.select({ metadata: inventoryTransactions.metadata, referenceId: inventoryTransactions.referenceId }).from(inventoryTransactions).where(eq(inventoryTransactions.id, transactionId)).limit(1),
    db.select({ productId: inventoryTransactionLines.productId, productName: products.name, sku: products.sku, quantity: inventoryTransactionLines.quantityDelta, closingRetailBalance: inventoryTransactionLines.closingBalance })
      .from(inventoryTransactionLines)
      .innerJoin(products, eq(products.id, inventoryTransactionLines.productId))
      .where(and(eq(inventoryTransactionLines.transactionId, transactionId), eq(inventoryTransactionLines.bucket, "retail"))),
  ]);
  const destination = typeof transaction[0]?.metadata.destination === "string" ? transaction[0].metadata.destination : "Retail destination";
  const resultLines = lines.map((line) => ({ ...line, quantity: Math.abs(line.quantity) }));
  return { transactionId, transactionNumber, duplicate, destination, totalQuantity: resultLines.reduce((total, line) => total + line.quantity, 0), lines: resultLines };
}

export async function dispatchRetailStock(input: RetailDispatchInput): Promise<RetailDispatchResult> {
  validateRetailDispatch(input);
  const db = getDatabase();
  const existing = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber, type: inventoryTransactions.type })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing[0]) {
    if (existing[0].type !== "retail_issue") throw new InventoryCommandError("INVALID_DISPATCH", "This request key belongs to a different inventory operation.");
    return readRetailDispatchResult(existing[0].id, existing[0].transactionNumber, true);
  }

  const result = await db.transaction(async (tx) => {
    const orderedLines = [...input.lines].sort((left, right) => left.productId.localeCompare(right.productId));
    const productIds = orderedLines.map((line) => line.productId);
    const [productRows, balances] = await Promise.all([
      tx.select({ id: products.id, name: products.name, sku: products.sku }).from(products).where(and(inArray(products.id, productIds), eq(products.active, true))),
      tx.select().from(inventoryBalances).where(and(
        inArray(inventoryBalances.productId, productIds),
        eq(inventoryBalances.warehouseLocationId, input.warehouseLocationId),
        eq(inventoryBalances.bucket, "retail"),
      )).orderBy(inventoryBalances.productId).for("update"),
    ]);
    const productById = new Map(productRows.map((product) => [product.id, product]));
    const balanceByProduct = new Map(balances.map((balance) => [balance.productId, balance]));
    if (productRows.length !== productIds.length) throw new InventoryCommandError("NOT_FOUND", "One or more dispatch products are missing or inactive.");

    for (const line of orderedLines) {
      const balance = balanceByProduct.get(line.productId);
      const product = productById.get(line.productId);
      const available = balance ? balance.onHand - balance.reserved : 0;
      if (!balance || available < line.quantity) throw new InventoryCommandError("INSUFFICIENT_STOCK", `${product?.name ?? "This product"} has only ${available} Retail packets available.`);
    }

    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const totalQuantity = orderedLines.reduce((total, line) => total + line.quantity, 0);
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: "retail_issue",
      idempotencyKey: input.idempotencyKey,
      referenceId: input.referenceId.trim(),
      actorUsername: input.actorUsername,
      reason: "Retail order dispatched from warehouse",
      metadata: { destination: input.destination.trim(), notes: input.notes?.trim() || null, totalQuantity, lineCount: orderedLines.length },
    }).returning({ id: inventoryTransactions.id });

    const transactionLines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
    const responseLines: RetailDispatchResult["lines"] = [];
    const previousValue: Record<string, number> = {};
    const newValue: Record<string, number> = {};
    for (const line of orderedLines) {
      const balance = balanceByProduct.get(line.productId)!;
      const product = productById.get(line.productId)!;
      const closingBalance = balance.onHand - line.quantity;
      await tx.update(inventoryBalances).set({ onHand: closingBalance, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
      transactionLines.push({ transactionId: transaction.id, productId: line.productId, warehouseLocationId: input.warehouseLocationId, bucket: "retail", quantityDelta: -line.quantity, openingBalance: balance.onHand, closingBalance });
      responseLines.push({ productId: product.id, productName: product.name, sku: product.sku, quantity: line.quantity, closingRetailBalance: closingBalance });
      previousValue[product.id] = balance.onHand;
      newValue[product.id] = closingBalance;
    }
    await tx.insert(inventoryTransactionLines).values(transactionLines);
    await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "inventory.retail_dispatched", entityType: "inventory_transaction", entityId: transaction.id, previousValue, newValue, reason: `Retail dispatch to ${input.destination.trim()} (${input.referenceId.trim()})` });
    return { transactionId: transaction.id, transactionNumber, duplicate: false, totalQuantity, destination: input.destination.trim(), lines: responseLines };
  }, { isolationLevel: "serializable" });
  return result;
}

export async function receiveAndAllocateStock(input: ReceiveStockInput): Promise<ReceiveStockResult> {
  validateReceipt(input);
  const db = getDatabase();
  const existing = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing[0]) return { transactionId: existing[0].id, transactionNumber: existing[0].transactionNumber, duplicate: true, receivedQuantity: input.receivedQuantity, shopifySync: input.onlineQuantity > 0 ? "pending" : "not_required" };

  return db.transaction(async (tx) => {
    let mapping: typeof shopifyMappings.$inferSelect | null = null;
    if (input.shopifyMappingId) {
      [mapping] = await tx.select().from(shopifyMappings).where(and(eq(shopifyMappings.id, input.shopifyMappingId), eq(shopifyMappings.productId, input.productId), eq(shopifyMappings.status, "mapped"))).limit(1);
      if (!mapping) throw new InventoryCommandError("MAPPING_REQUIRED", "The Shopify mapping is missing, conflicted, inactive, or belongs to another product.");
    }

    const allocation = new Map<InventoryBucket, number>([
      ["online", input.onlineQuantity], ["retail", input.retailQuantity], ["buffer", input.bufferQuantity], ["damaged", input.damagedQuantity],
    ]);
    const buckets = [...allocation.entries()].filter(([, quantity]) => quantity > 0).map(([bucket]) => bucket);
    await tx.insert(inventoryBalances).values(buckets.map((bucket) => ({ productId: input.productId, warehouseLocationId: input.warehouseLocationId, bucket })))
      .onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });
    const balances = await tx.select().from(inventoryBalances).where(and(eq(inventoryBalances.productId, input.productId), eq(inventoryBalances.warehouseLocationId, input.warehouseLocationId), inArray(inventoryBalances.bucket, buckets))).orderBy(inventoryBalances.bucket).for("update");
    if (balances.length !== buckets.length) throw new InventoryCommandError("NOT_FOUND", "Receipt balances could not be created.");

    const [batch] = await tx.insert(inventoryBatches).values({
      productId: input.productId,
      warehouseLocationId: input.warehouseLocationId,
      batchNumber: input.batchNumber.trim(),
      manufacturingDate: input.manufacturingDate,
      expiryDate: input.expiryDate,
      receivedQuantity: input.receivedQuantity,
    }).onConflictDoUpdate({
      target: [inventoryBatches.productId, inventoryBatches.warehouseLocationId, inventoryBatches.batchNumber],
      set: { receivedQuantity: sql`${inventoryBatches.receivedQuantity} + ${input.receivedQuantity}`, updatedAt: new Date() },
    }).returning({ id: inventoryBatches.id });

    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: "stock_received",
      idempotencyKey: input.idempotencyKey,
      referenceId: input.referenceId,
      actorUsername: input.actorUsername,
      reason: input.reason,
      metadata: { source: input.source, batchNumber: input.batchNumber },
    }).returning({ id: inventoryTransactions.id });

    const lines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
    const previousValue: Record<string, number> = {};
    const newValue: Record<string, number> = {};
    for (const balance of balances) {
      const quantity = allocation.get(balance.bucket) ?? 0;
      const closingBalance = balance.onHand + quantity;
      await tx.update(inventoryBalances).set({ onHand: closingBalance, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
      lines.push({ transactionId: transaction.id, productId: input.productId, warehouseLocationId: input.warehouseLocationId, batchId: batch.id, bucket: balance.bucket, quantityDelta: quantity, openingBalance: balance.onHand, closingBalance });
      previousValue[balance.bucket] = balance.onHand;
      newValue[balance.bucket] = closingBalance;
    }
    await tx.insert(inventoryTransactionLines).values(lines);

    if (input.onlineQuantity > 0 && mapping) {
      await tx.insert(integrationOutbox).values({ transactionId: transaction.id, operation: "shopify_inventory_adjust", idempotencyKey: `${input.idempotencyKey}:shopify`, payload: { shopifyInventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, quantityDelta: input.onlineQuantity, reason: "received" } });
    }
    await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "inventory.stock_received", entityType: "inventory_transaction", entityId: transaction.id, previousValue, newValue, reason: input.reason });
    return { transactionId: transaction.id, transactionNumber, duplicate: false, receivedQuantity: input.receivedQuantity, shopifySync: input.onlineQuantity > 0 ? "pending" : "not_required" };
  }, { isolationLevel: "serializable" });
}

export async function transferInventory(input: TransferInventoryInput): Promise<TransferInventoryResult> {
  validateTransfer(input);
  const db = getDatabase();

  const existing = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing[0]) {
    const lines = await db.select({ bucket: inventoryTransactionLines.bucket, closing: inventoryTransactionLines.closingBalance })
      .from(inventoryTransactionLines).where(eq(inventoryTransactionLines.transactionId, existing[0].id));
    return {
      transactionId: existing[0].id,
      transactionNumber: existing[0].transactionNumber,
      duplicate: true,
      fromClosingBalance: lines.find((line) => line.bucket === input.fromBucket)?.closing ?? 0,
      toClosingBalance: lines.find((line) => line.bucket === input.toBucket)?.closing ?? 0,
      shopifySync: input.fromBucket === "online" || input.toBucket === "online" ? "pending" : "not_required",
    };
  }

  return db.transaction(async (tx) => {
    await tx.insert(inventoryBalances).values([
      { productId: input.productId, warehouseLocationId: input.warehouseLocationId, bucket: input.fromBucket },
      { productId: input.productId, warehouseLocationId: input.warehouseLocationId, bucket: input.toBucket },
    ]).onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });

    const balances = await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.productId, input.productId),
      eq(inventoryBalances.warehouseLocationId, input.warehouseLocationId),
      inArray(inventoryBalances.bucket, [input.fromBucket, input.toBucket]),
    )).orderBy(inventoryBalances.bucket).for("update");
    const source = balances.find((balance) => balance.bucket === input.fromBucket);
    const destination = balances.find((balance) => balance.bucket === input.toBucket);
    if (!source || !destination) throw new InventoryCommandError("NOT_FOUND", "Inventory balances could not be created.");

    const transferable = source.onHand - source.reserved;
    if (transferable < input.quantity) {
      throw new InventoryCommandError("INSUFFICIENT_STOCK", `Only ${transferable} unreserved units are available in ${input.fromBucket}.`);
    }

    let mapping: typeof shopifyMappings.$inferSelect | null = null;
    if (input.shopifyMappingId) {
      [mapping] = await tx.select().from(shopifyMappings).where(and(
        eq(shopifyMappings.id, input.shopifyMappingId),
        eq(shopifyMappings.productId, input.productId),
        eq(shopifyMappings.status, "mapped"),
      )).limit(1);
      if (!mapping) throw new InventoryCommandError("MAPPING_REQUIRED", "The Shopify mapping is missing, inactive, or belongs to another product.");
    }

    const fromClosingBalance = source.onHand - input.quantity;
    const toClosingBalance = destination.onHand + input.quantity;
    await tx.update(inventoryBalances).set({ onHand: fromClosingBalance, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, source.id));
    await tx.update(inventoryBalances).set({ onHand: toClosingBalance, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, destination.id));

    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: "channel_transfer",
      idempotencyKey: input.idempotencyKey,
      referenceId: input.referenceId,
      actorUsername: input.actorUsername,
      reason: input.reason,
      metadata: { fromBucket: input.fromBucket, toBucket: input.toBucket },
    }).returning({ id: inventoryTransactions.id });

    await tx.insert(inventoryTransactionLines).values([
      { transactionId: transaction.id, productId: input.productId, warehouseLocationId: input.warehouseLocationId, bucket: input.fromBucket, quantityDelta: -input.quantity, openingBalance: source.onHand, closingBalance: fromClosingBalance },
      { transactionId: transaction.id, productId: input.productId, warehouseLocationId: input.warehouseLocationId, bucket: input.toBucket, quantityDelta: input.quantity, openingBalance: destination.onHand, closingBalance: toClosingBalance },
    ]);

    const affectsOnline = input.fromBucket === "online" || input.toBucket === "online";
    if (affectsOnline && mapping) {
      const quantityDelta = input.toBucket === "online" ? input.quantity : -input.quantity;
      await tx.insert(integrationOutbox).values({
        transactionId: transaction.id,
        operation: "shopify_inventory_adjust",
        idempotencyKey: `${input.idempotencyKey}:shopify`,
        payload: {
          shopifyInventoryItemId: mapping.shopifyInventoryItemId,
          shopifyLocationId: mapping.shopifyLocationId,
          quantityDelta,
          reason: "correction",
        },
      });
    }

    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "inventory.channel_transfer",
      entityType: "inventory_transaction",
      entityId: transaction.id,
      previousValue: { [input.fromBucket]: source.onHand, [input.toBucket]: destination.onHand },
      newValue: { [input.fromBucket]: fromClosingBalance, [input.toBucket]: toClosingBalance },
      reason: input.reason,
    });

    return {
      transactionId: transaction.id,
      transactionNumber,
      duplicate: false,
      fromClosingBalance,
      toClosingBalance,
      shopifySync: affectsOnline ? "pending" : "not_required",
    };
  }, { isolationLevel: "serializable" });
}
