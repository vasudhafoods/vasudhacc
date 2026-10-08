import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import {
  auditEvents,
  integrationOutbox,
  inventoryBalances,
  inventoryBatches,
  inventoryReceiptAttachments,
  inventoryTransactionLines,
  inventoryTransactions,
  products,
  shopifyMappings,
  warehouseLocations,
  type InventoryBucket,
} from "@/db/schema";
import type { ShopifySyncStatus } from "@/types/warehouse";
import { addProductToShopify } from "@/services/shopify-products";
import { receiptAllocation } from "@/lib/inventory/allocation";
import { isPhysicalUnitProduct } from "@/lib/inventory/physical-units";
import { targetChannelBalances } from "@/lib/inventory/stock-rotation";

type DatabaseTransaction = Parameters<Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]>[0];

async function rebalanceChannelStock(tx: DatabaseTransaction, input: { productIds: string[]; warehouseLocationId: string; actorUsername: string; idempotencyKey: string; reason: string; referenceId: string }) {
  const productIds = [...new Set(input.productIds)];
  if (!productIds.length) return null;
  const buckets = ["online", "retail", "buffer"] as const;
  await tx.insert(inventoryBalances).values(productIds.flatMap((productId) => buckets.map((bucket) => ({ productId, warehouseLocationId: input.warehouseLocationId, bucket }))))
    .onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });
  const balances = await tx.select().from(inventoryBalances).where(and(inArray(inventoryBalances.productId, productIds), eq(inventoryBalances.warehouseLocationId, input.warehouseLocationId), inArray(inventoryBalances.bucket, [...buckets])))
    .orderBy(inventoryBalances.productId, inventoryBalances.bucket).for("update");
  const grouped = new Map<string, typeof balances>();
  for (const balance of balances) grouped.set(balance.productId, [...(grouped.get(balance.productId) ?? []), balance]);
  const plans = [...grouped].flatMap(([productId, rows]) => {
    const target = targetChannelBalances(rows.map(({ bucket, onHand, reserved }) => ({ bucket: bucket as "online" | "retail" | "buffer", onHand, reserved })));
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));
    return buckets.some((bucket) => target[bucket] !== (byBucket.get(bucket)?.onHand ?? 0)) ? [{ productId, rows, target, byBucket }] : [];
  });
  if (!plans.length) return null;
  const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const [transaction] = await tx.insert(inventoryTransactions).values({ transactionNumber, type: "channel_transfer", idempotencyKey: input.idempotencyKey, referenceId: input.referenceId, actorUsername: input.actorUsername, reason: input.reason, metadata: { action: "automatic_stock_rotation", policy: "40/40/20", unit: "individual_packet" } }).returning({ id: inventoryTransactions.id });
  const lines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
  const previousValue: Record<string, number> = {};
  const newValue: Record<string, number> = {};
  for (const plan of plans) for (const bucket of buckets) {
    const balance = plan.byBucket.get(bucket)!;
    const closing = plan.target[bucket];
    if (closing === balance.onHand) continue;
    await tx.update(inventoryBalances).set({ onHand: closing, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
    lines.push({ transactionId: transaction.id, productId: plan.productId, warehouseLocationId: input.warehouseLocationId, bucket, quantityDelta: closing - balance.onHand, openingBalance: balance.onHand, closingBalance: closing });
    previousValue[`${plan.productId}:${bucket}`] = balance.onHand;
    newValue[`${plan.productId}:${bucket}`] = closing;
  }
  if (lines.length) await tx.insert(inventoryTransactionLines).values(lines);
  const changedOnline = plans.filter((plan) => plan.target.online !== (plan.byBucket.get("online")?.onHand ?? 0));
  if (changedOnline.length) {
    const mappings = await tx.select().from(shopifyMappings).where(and(inArray(shopifyMappings.productId, changedOnline.map((plan) => plan.productId)), eq(shopifyMappings.status, "mapped")));
    const mappingByProduct = new Map<string, typeof shopifyMappings.$inferSelect>();
    for (const mapping of mappings) if (!mappingByProduct.has(mapping.productId)) mappingByProduct.set(mapping.productId, mapping);
    const targets = changedOnline.flatMap((plan) => { const mapping = mappingByProduct.get(plan.productId); return mapping ? [{ plan, mapping }] : []; });
    if (targets.length) {
      const itemIds = new Set(targets.map(({ mapping }) => mapping.shopifyInventoryItemId));
      const oldJobs = await tx.select({ id: integrationOutbox.id, payload: integrationOutbox.payload }).from(integrationOutbox).where(and(eq(integrationOutbox.operation, "shopify_inventory_adjust"), inArray(integrationOutbox.status, ["pending", "failed"])));
      const superseded = oldJobs.filter((job) => typeof job.payload.shopifyInventoryItemId === "string" && itemIds.has(job.payload.shopifyInventoryItemId)).map((job) => job.id);
      if (superseded.length) await tx.update(integrationOutbox).set({ status: "cancelled", lockedAt: null, completedAt: new Date(), lastError: "Superseded by automatic 40/40/20 stock rotation.", updatedAt: new Date() }).where(inArray(integrationOutbox.id, superseded));
      await tx.insert(integrationOutbox).values(targets.map(({ plan, mapping }, index) => ({ transactionId: transaction.id, operation: "shopify_inventory_adjust", idempotencyKey: `${input.idempotencyKey}:shopify:${index}`, payload: { shopifyInventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, quantity: plan.target.online, reason: "correction" } })));
    }
  }
  await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "inventory.stock_rotated", entityType: "inventory_transaction", entityId: transaction.id, previousValue, newValue, reason: input.reason });
  return transaction.id;
}

export class InventoryCommandError extends Error {
  constructor(readonly code: "INVALID_TRANSFER" | "INVALID_RECEIPT" | "INVALID_DISPATCH" | "INVALID_RETURN" | "INVALID_DISPOSAL" | "INSUFFICIENT_STOCK" | "MAPPING_REQUIRED" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "InventoryCommandError";
  }
}

export interface ReceiveStockInput {
  addToShopify?: boolean;
  invoiceTransactionId?: string;
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
  supplierName?: string;
  invoiceValuePaisa?: number;
  receivedAt?: Date;
  idempotencyKey: string;
  shopifyMappingId?: string;
  referenceId?: string;
}

export interface ReceiveStockResult {
  transactionId: string;
  transactionNumber: string;
  duplicate: boolean;
  receivedQuantity: number;
  stockRotationTransactionId: string | null;
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
  stockRotationTransactionId: string | null;
  shopifySync: ShopifySyncStatus;
}

export interface RetailDispatchInput {
  warehouseLocationId: string;
  lines: { productId: string; quantity: number; unitPricePaisa: number }[];
  destination: string;
  referenceId: string;
  deliveryDate: Date;
  orderType: "retail" | "sample" | "inhand" | "other";
  orderValuePaisa: number;
  deliveryStatus: "packing" | "shipped" | "dispatched" | "delivered";
  deliveryPartner: string;
  deliveryCostPaisa: number;
  lrNumber: string;
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
  stockTransferTransactionId: string | null;
  stockRotationTransactionId: string | null;
  shopifySync: ShopifySyncStatus;
  lines: { productId: string; productName: string; sku: string; quantity: number; closingRetailBalance: number; movedFromBuffer: number; movedFromOnline: number }[];
}

export interface ReceiveReturnInput {
  productId: string;
  warehouseLocationId: string;
  quantity: number;
  channel: "retail" | "shopify";
  referenceId: string;
  reason: string;
  orderType: "retail" | "shopify";
  courier?: string;
  rtoCostPaisa?: number;
  manifestedAt?: Date;
  receivedAt?: Date;
  condition: "usable" | "damaged" | "missing" | "expired";
  notes?: string;
  actorUsername: string;
  idempotencyKey: string;
}

export interface ReceiveReturnResult {
  transactionId: string;
  transactionNumber: string;
  duplicate: boolean;
  quantity: number;
  qcClosingBalance: number;
  channel: "retail" | "shopify";
  condition: "usable" | "damaged" | "missing" | "expired";
  stockBucket: "qc" | "damaged" | "retail" | null;
}

export interface DisposeInventoryInput {
  productId: string;
  warehouseLocationId: string;
  sourceBucket: InventoryBucket;
  quantity: number;
  disposalReason: "expired" | "damaged" | "contaminated" | "quality_rejected" | "other";
  expiryDate: Date;
  referenceId: string;
  notes?: string;
  actorUsername: string;
  idempotencyKey: string;
  shopifyMappingId?: string;
  approvalProof?: { fileName: string; contentType: string; fileSize: number; contentBase64: string };
}

export interface DisposeInventoryResult {
  transactionId: string;
  transactionNumber: string;
  duplicate: boolean;
  quantity: number;
  sourceBucket: InventoryBucket;
  closingBalance: number;
  stockRotationTransactionId: string | null;
  shopifySync: ShopifySyncStatus;
}

function validateTransfer(input: TransferInventoryInput) {
  if (input.fromBucket === input.toBucket) throw new InventoryCommandError("INVALID_TRANSFER", "Source and destination buckets must differ.");
  if (input.toBucket === "retail" && !["qc", "buffer", "online"].includes(input.fromBucket)) throw new InventoryCommandError("INVALID_TRANSFER", "Retail can receive stock from inspected QC, Buffer, or Online.");
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new InventoryCommandError("INVALID_TRANSFER", "Quantity must be a positive whole number.");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new InventoryCommandError("INVALID_TRANSFER", "A valid idempotency key is required.");
  if (!input.actorUsername.trim() || !input.reason.trim()) throw new InventoryCommandError("INVALID_TRANSFER", "Actor and reason are required.");
  if ((input.fromBucket === "online" || input.toBucket === "online") && !input.shopifyMappingId) {
    throw new InventoryCommandError("MAPPING_REQUIRED", "A verified Shopify mapping is required when moving Online stock.");
  }
}

function validateReceipt(input: ReceiveStockInput) {
  const quantities = [input.receivedQuantity, input.damagedQuantity, input.onlineQuantity, input.retailQuantity, input.bufferQuantity];
  if (quantities.some((quantity) => !Number.isSafeInteger(quantity) || quantity < 0) || input.receivedQuantity <= 0) {
    throw new InventoryCommandError("INVALID_RECEIPT", "Receipt quantities must be non-negative whole numbers and received quantity must be positive.");
  }
  if (input.onlineQuantity + input.retailQuantity + input.bufferQuantity + input.damagedQuantity !== input.receivedQuantity) {
    throw new InventoryCommandError("INVALID_RECEIPT", "Shopify, Retail, Buffer and Damaged allocation must equal the received quantity.");
  }
  if (!input.expiryDate || !Number.isFinite(input.expiryDate.getTime())) throw new InventoryCommandError("INVALID_RECEIPT", "An expiry date is required for every received product.");
  if (!input.receivedAt || !Number.isFinite(input.receivedAt.getTime())) throw new InventoryCommandError("INVALID_RECEIPT", "A valid receiving date is required.");
  if (!input.supplierName?.trim() || !input.referenceId?.trim()) throw new InventoryCommandError("INVALID_RECEIPT", "Supplier name and invoice number are required.");
  if (!input.invoiceTransactionId && (!Number.isSafeInteger(input.invoiceValuePaisa) || (input.invoiceValuePaisa ?? 0) <= 0)) throw new InventoryCommandError("INVALID_RECEIPT", "A valid invoice value greater than zero is required.");
  if (input.expiryDate < input.receivedAt) throw new InventoryCommandError("INVALID_RECEIPT", "Expiry date cannot be before the receiving date.");
  const usableQuantity = input.receivedQuantity - input.damagedQuantity;
  const { online: expectedOnlineQuantity, retail: expectedRetailQuantity, buffer: expectedBufferQuantity } = receiptAllocation(usableQuantity);
  if (input.onlineQuantity !== expectedOnlineQuantity || input.retailQuantity !== expectedRetailQuantity || input.bufferQuantity !== expectedBufferQuantity) {
    throw new InventoryCommandError("INVALID_RECEIPT", `Usable stock must be allocated automatically: ${expectedOnlineQuantity} packets to Shopify, ${expectedRetailQuantity} packets to Retail and ${expectedBufferQuantity} packets to Buffer.`);
  }
  if (!input.batchNumber.trim() || !input.source.trim() || !input.reason.trim() || !input.actorUsername.trim() || !input.idempotencyKey.trim()) {
    throw new InventoryCommandError("INVALID_RECEIPT", "Batch, source, reason, actor and idempotency key are required.");
  }
}

function validateRetailDispatch(input: RetailDispatchInput) {
  if (!input.warehouseLocationId.trim()) throw new InventoryCommandError("INVALID_DISPATCH", "Select the warehouse dispatching this stock.");
  if (!input.destination.trim() || input.destination.trim().length > 200) throw new InventoryCommandError("INVALID_DISPATCH", "Enter a valid retail destination of 200 characters or fewer.");
  if (!input.referenceId.trim() || input.referenceId.trim().length > 100) throw new InventoryCommandError("INVALID_DISPATCH", "Enter an invoice, order, or dispatch reference of 100 characters or fewer.");
  if (!Number.isFinite(input.deliveryDate.getTime())) throw new InventoryCommandError("INVALID_DISPATCH", "Enter a valid delivery date.");
  if (!(new Set(["retail", "sample", "inhand", "other"])).has(input.orderType)) throw new InventoryCommandError("INVALID_DISPATCH", "Select a valid order type.");
  if (!Number.isSafeInteger(input.orderValuePaisa) || input.orderValuePaisa <= 0) throw new InventoryCommandError("INVALID_DISPATCH", "Enter a valid order value greater than zero.");
  if (!(new Set(["packing", "shipped", "dispatched", "delivered"])).has(input.deliveryStatus)) throw new InventoryCommandError("INVALID_DISPATCH", "Select a valid delivery status.");
  if (!input.deliveryPartner.trim() || input.deliveryPartner.length > 160) throw new InventoryCommandError("INVALID_DISPATCH", "Enter the delivery partner.");
  if (!Number.isSafeInteger(input.deliveryCostPaisa) || input.deliveryCostPaisa < 0) throw new InventoryCommandError("INVALID_DISPATCH", "Enter a valid delivery cost (zero is allowed).");
  if (!input.lrNumber.trim() || input.lrNumber.length > 100) throw new InventoryCommandError("INVALID_DISPATCH", "Enter the LR number.");
  if (!input.actorUsername.trim() || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new InventoryCommandError("INVALID_DISPATCH", "Actor and idempotency key are required.");
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) throw new InventoryCommandError("INVALID_DISPATCH", "Add between 1 and 50 products to the dispatch.");
  const productIds = new Set<string>();
  for (const line of input.lines) {
    if (!line.productId.trim() || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !Number.isSafeInteger(line.unitPricePaisa) || line.unitPricePaisa <= 0) throw new InventoryCommandError("INVALID_DISPATCH", "Every dispatch line needs a product, positive whole-packet quantity, and unit sale price.");
    if (productIds.has(line.productId)) throw new InventoryCommandError("INVALID_DISPATCH", "Add each product only once; update its quantity on the existing line.");
    productIds.add(line.productId);
  }
  if (input.notes && input.notes.trim().length > 500) throw new InventoryCommandError("INVALID_DISPATCH", "Dispatch notes must be 500 characters or fewer.");
}

function validateReturn(input: ReceiveReturnInput) {
  if (!input.productId.trim() || !input.warehouseLocationId.trim()) throw new InventoryCommandError("INVALID_RETURN", "Select a product and warehouse location.");
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new InventoryCommandError("INVALID_RETURN", "Return quantity must be a positive whole-packet number.");
  if (input.channel !== "retail" && input.channel !== "shopify") throw new InventoryCommandError("INVALID_RETURN", "Select Retail or Shopify as the return channel.");
  if (input.orderType !== "retail" && input.orderType !== "shopify") throw new InventoryCommandError("INVALID_RETURN", "Select Retail or D2C as the order type.");
  if (!(new Set(["usable", "damaged", "missing", "expired"])).has(input.condition)) throw new InventoryCommandError("INVALID_RETURN", "Select the returned item condition.");
  if (input.rtoCostPaisa !== undefined && (!Number.isSafeInteger(input.rtoCostPaisa) || input.rtoCostPaisa < 0)) throw new InventoryCommandError("INVALID_RETURN", "Enter a valid non-negative RTO cost.");
  if (input.manifestedAt && !Number.isFinite(input.manifestedAt.getTime())) throw new InventoryCommandError("INVALID_RETURN", "Enter a valid RTO manifested date.");
  if (input.receivedAt && !Number.isFinite(input.receivedAt.getTime())) throw new InventoryCommandError("INVALID_RETURN", "Enter a valid RTO received date.");
  if (!input.referenceId.trim() || input.referenceId.trim().length > 100) throw new InventoryCommandError("INVALID_RETURN", "Enter a valid order, invoice, or return reference of 100 characters or fewer.");
  if (!input.reason.trim() || input.reason.trim().length > 200) throw new InventoryCommandError("INVALID_RETURN", "Enter a return reason of 200 characters or fewer.");
  if (!input.actorUsername.trim() || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new InventoryCommandError("INVALID_RETURN", "Actor and idempotency key are required.");
  if (input.notes && input.notes.trim().length > 500) throw new InventoryCommandError("INVALID_RETURN", "Return notes must be 500 characters or fewer.");
}

function validateDisposal(input: DisposeInventoryInput) {
  if (!input.productId.trim() || !input.warehouseLocationId.trim()) throw new InventoryCommandError("INVALID_DISPOSAL", "Select a product and warehouse location.");
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new InventoryCommandError("INVALID_DISPOSAL", "Disposal quantity must be a positive whole-packet number.");
  if (!Number.isFinite(input.expiryDate.getTime())) throw new InventoryCommandError("INVALID_DISPOSAL", "Enter a valid product expiry date.");
  if (!(["expired", "damaged", "contaminated", "quality_rejected", "other"] as const).includes(input.disposalReason)) throw new InventoryCommandError("INVALID_DISPOSAL", "Select a valid disposal reason.");
  if (!input.referenceId.trim() || input.referenceId.trim().length > 100) throw new InventoryCommandError("INVALID_DISPOSAL", "Enter a valid disposal reference of 100 characters or fewer.");
  if (!input.actorUsername.trim() || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new InventoryCommandError("INVALID_DISPOSAL", "Actor and idempotency key are required.");
  if (input.notes && input.notes.trim().length > 500) throw new InventoryCommandError("INVALID_DISPOSAL", "Disposal notes must be 500 characters or fewer.");
  if (input.sourceBucket === "online" && !input.shopifyMappingId) throw new InventoryCommandError("MAPPING_REQUIRED", "A verified Shopify mapping is required when disposing Online stock.");
}

async function readRetailDispatchResult(transactionId: string, transactionNumber: string, duplicate: boolean, idempotencyKey: string): Promise<RetailDispatchResult> {
  const db = getDatabase();
  const [transaction, lines, rotationRows] = await Promise.all([
    db.select({ metadata: inventoryTransactions.metadata, referenceId: inventoryTransactions.referenceId }).from(inventoryTransactions).where(eq(inventoryTransactions.id, transactionId)).limit(1),
    db.select({ productId: inventoryTransactionLines.productId, productName: products.name, sku: products.sku, quantity: inventoryTransactionLines.quantityDelta, closingRetailBalance: inventoryTransactionLines.closingBalance })
      .from(inventoryTransactionLines)
      .innerJoin(products, eq(products.id, inventoryTransactionLines.productId))
      .where(and(eq(inventoryTransactionLines.transactionId, transactionId), eq(inventoryTransactionLines.bucket, "retail"))),
    db.select({ id: inventoryTransactions.id }).from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, `${idempotencyKey}:stock-rotation`)).limit(1),
  ]);
  const metadata = transaction[0]?.metadata ?? {};
  const destination = typeof metadata.destination === "string" ? metadata.destination : "Retail destination";
  const stockTransferTransactionId = typeof metadata.stockTransferTransactionId === "string" ? metadata.stockTransferTransactionId : null;
  const stockRotationTransactionId = rotationRows[0]?.id ?? null;
  const transfers = Array.isArray(metadata.stockTransfers) ? metadata.stockTransfers as { productId?: unknown; movedFromBuffer?: unknown; movedFromOnline?: unknown }[] : [];
  const transferByProduct = new Map(transfers.filter((line) => typeof line.productId === "string").map((line) => [line.productId as string, {
    movedFromBuffer: Number(line.movedFromBuffer) || 0,
    movedFromOnline: Number(line.movedFromOnline) || 0,
  }]));
  const resultLines = lines.map((line) => ({
    ...line,
    quantity: Math.abs(line.quantity),
    movedFromBuffer: transferByProduct.get(line.productId)?.movedFromBuffer ?? 0,
    movedFromOnline: transferByProduct.get(line.productId)?.movedFromOnline ?? 0,
  }));
  const requiresShopifySync = resultLines.some((line) => line.movedFromOnline > 0);
  return { transactionId, transactionNumber, duplicate, destination, totalQuantity: resultLines.reduce((total, line) => total + line.quantity, 0), stockTransferTransactionId, stockRotationTransactionId, shopifySync: requiresShopifySync || stockRotationTransactionId ? "pending" : "not_required", lines: resultLines };
}

export async function dispatchRetailStock(input: RetailDispatchInput): Promise<RetailDispatchResult> {
  validateRetailDispatch(input);
  const db = getDatabase();
  const existing = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber, type: inventoryTransactions.type })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing[0]) {
    if (existing[0].type !== "retail_issue") throw new InventoryCommandError("INVALID_DISPATCH", "This request key belongs to a different inventory operation.");
    return readRetailDispatchResult(existing[0].id, existing[0].transactionNumber, true, input.idempotencyKey);
  }

  return db.transaction(async (tx) => {
    const orderedLines = [...input.lines].sort((left, right) => left.productId.localeCompare(right.productId));
    const productIds = orderedLines.map((line) => line.productId);
    const productRows = await tx.select({ id: products.id, name: products.name, sku: products.sku }).from(products)
      .where(and(inArray(products.id, productIds), eq(products.active, true)));
    const productById = new Map(productRows.map((product) => [product.id, product]));
    if (productRows.length !== productIds.length) throw new InventoryCommandError("NOT_FOUND", "One or more dispatch products are missing or inactive.");
    for (const product of productRows) if (!isPhysicalUnitProduct(product.name)) {
      throw new InventoryCommandError("INVALID_DISPATCH", "Dispatch individual physical units. Pack listings and bundles do not hold separate warehouse stock.");
    }

    const buckets = ["retail", "buffer", "online"] as const;
    await tx.insert(inventoryBalances).values(productIds.flatMap((productId) => buckets.map((bucket) => ({
      productId,
      warehouseLocationId: input.warehouseLocationId,
      bucket,
    })))).onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });
    const balances = await tx.select().from(inventoryBalances).where(and(
      inArray(inventoryBalances.productId, productIds),
      eq(inventoryBalances.warehouseLocationId, input.warehouseLocationId),
      inArray(inventoryBalances.bucket, [...buckets]),
    )).orderBy(inventoryBalances.productId, inventoryBalances.bucket).for("update");
    const balanceByScope = new Map(balances.map((balance) => [`${balance.productId}:${balance.bucket}`, balance]));
    const transferPlans = orderedLines.map((line) => {
      const retail = balanceByScope.get(`${line.productId}:retail`)!;
      const buffer = balanceByScope.get(`${line.productId}:buffer`)!;
      const online = balanceByScope.get(`${line.productId}:online`)!;
      const retailAvailable = Math.max(0, retail.onHand - retail.reserved);
      const bufferAvailable = Math.max(0, buffer.onHand - buffer.reserved);
      const onlineAvailable = Math.max(0, online.onHand - online.reserved);
      let shortfall = Math.max(0, line.quantity - retailAvailable);
      const movedFromBuffer = Math.min(shortfall, bufferAvailable);
      shortfall -= movedFromBuffer;
      const movedFromOnline = Math.min(shortfall, onlineAvailable);
      shortfall -= movedFromOnline;
      if (shortfall > 0) {
        const product = productById.get(line.productId)!;
        throw new InventoryCommandError("INSUFFICIENT_STOCK", `${product.name} has only ${retailAvailable + bufferAvailable + onlineAvailable} available physical units across Retail, Buffer, and Online.`);
      }
      return { line, retail, buffer, online, movedFromBuffer, movedFromOnline };
    });
    const onlinePlans = transferPlans.filter((plan) => plan.movedFromOnline > 0);
    const mappings = onlinePlans.length ? await tx.select().from(shopifyMappings).where(and(
      inArray(shopifyMappings.productId, [...new Set(onlinePlans.map((plan) => plan.line.productId))]),
      eq(shopifyMappings.status, "mapped"),
    )) : [];
    const mappingByProduct = new Map<string, typeof shopifyMappings.$inferSelect>();
    for (const mapping of mappings) if (!mappingByProduct.has(mapping.productId)) mappingByProduct.set(mapping.productId, mapping);
    for (const plan of onlinePlans) if (!mappingByProduct.has(plan.line.productId)) {
      throw new InventoryCommandError("MAPPING_REQUIRED", `${productById.get(plan.line.productId)?.name ?? "This product"} has Online units but no verified Shopify mapping. Reconcile its listing before moving those units to Retail.`);
    }

    const totalQuantity = orderedLines.reduce((total, line) => total + line.quantity, 0);
    const stockTransfers = transferPlans.map((plan) => ({
      productId: plan.line.productId,
      movedFromBuffer: plan.movedFromBuffer,
      movedFromOnline: plan.movedFromOnline,
    }));
    const hasTransfers = transferPlans.some((plan) => plan.movedFromBuffer > 0 || plan.movedFromOnline > 0);
    let stockTransferTransactionId: string | null = null;
    if (hasTransfers) {
      const transferNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const [transfer] = await tx.insert(inventoryTransactions).values({
        transactionNumber: transferNumber,
        type: "channel_transfer",
        idempotencyKey: `${input.idempotencyKey}:retail-replenish`,
        referenceId: input.referenceId.trim(),
        actorUsername: input.actorUsername,
        reason: "Retail dispatch replenishment from Buffer and Online stock",
        occurredAt: input.deliveryDate,
        metadata: { action: "retail_dispatch_replenishment", destination: input.destination.trim(), toBucket: "retail", fromBuckets: ["buffer", "online"], stockTransfers },
      }).returning({ id: inventoryTransactions.id });
      stockTransferTransactionId = transfer.id;
      const transferLines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
      const previousValue: Record<string, number> = {};
      const newValue: Record<string, number> = {};
      for (const plan of transferPlans) {
        const { line, retail, buffer, online, movedFromBuffer, movedFromOnline } = plan;
        if (movedFromBuffer === 0 && movedFromOnline === 0) continue;
        if (movedFromBuffer > 0) {
          const closing = buffer.onHand - movedFromBuffer;
          await tx.update(inventoryBalances).set({ onHand: closing, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, buffer.id));
          transferLines.push({ transactionId: transfer.id, productId: line.productId, warehouseLocationId: input.warehouseLocationId, bucket: "buffer", quantityDelta: -movedFromBuffer, openingBalance: buffer.onHand, closingBalance: closing });
          previousValue[`${line.productId}:buffer`] = buffer.onHand;
          newValue[`${line.productId}:buffer`] = closing;
        }
        if (movedFromOnline > 0) {
          const closing = online.onHand - movedFromOnline;
          await tx.update(inventoryBalances).set({ onHand: closing, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, online.id));
          transferLines.push({ transactionId: transfer.id, productId: line.productId, warehouseLocationId: input.warehouseLocationId, bucket: "online", quantityDelta: -movedFromOnline, openingBalance: online.onHand, closingBalance: closing });
          previousValue[`${line.productId}:online`] = online.onHand;
          newValue[`${line.productId}:online`] = closing;
        }
        const movedToRetail = movedFromBuffer + movedFromOnline;
        const retailClosing = retail.onHand + movedToRetail;
        await tx.update(inventoryBalances).set({ onHand: retailClosing, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, retail.id));
        transferLines.push({ transactionId: transfer.id, productId: line.productId, warehouseLocationId: input.warehouseLocationId, bucket: "retail", quantityDelta: movedToRetail, openingBalance: retail.onHand, closingBalance: retailClosing });
        previousValue[`${line.productId}:retail`] = retail.onHand;
        newValue[`${line.productId}:retail`] = retailClosing;
      }
      if (transferLines.length) await tx.insert(inventoryTransactionLines).values(transferLines);
      if (onlinePlans.length) {
        await tx.insert(integrationOutbox).values(onlinePlans.map((plan, index) => {
          const mapping = mappingByProduct.get(plan.line.productId)!;
          return {
            transactionId: transfer.id,
            operation: "shopify_inventory_adjust" as const,
            idempotencyKey: `${input.idempotencyKey}:retail-replenish:shopify:${index}`,
            payload: { shopifyInventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, quantityDelta: -plan.movedFromOnline, reason: "correction" },
          };
        }));
      }
      await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "inventory.channel_transfer", entityType: "inventory_transaction", entityId: transfer.id, previousValue, newValue, reason: "Individual units shifted into Retail to cover dispatch demand." });
    }

    const retailAfterTransfer = new Map(transferPlans.map((plan) => [plan.line.productId, {
      ...plan.retail,
      onHand: plan.retail.onHand + plan.movedFromBuffer + plan.movedFromOnline,
    }]));
    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: "retail_issue",
      idempotencyKey: input.idempotencyKey,
      referenceId: input.referenceId.trim(),
      actorUsername: input.actorUsername,
      reason: "Retail order dispatched from warehouse",
      occurredAt: input.deliveryDate,
      metadata: { destination: input.destination.trim(), notes: input.notes?.trim() || null, totalQuantity, lineCount: orderedLines.length, orderType: input.orderType, orderValuePaisa: input.orderValuePaisa, deliveryStatus: input.deliveryStatus, deliveryPartner: input.deliveryPartner.trim(), deliveryCostPaisa: input.deliveryCostPaisa, lrNumber: input.lrNumber.trim(), stockTransferTransactionId, stockTransfers, lines: orderedLines.map((line) => ({ productId: line.productId, quantity: line.quantity, unitPricePaisa: line.unitPricePaisa })) },
    }).returning({ id: inventoryTransactions.id });

    const transactionLines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
    const responseLines: RetailDispatchResult["lines"] = [];
    const previousValue: Record<string, number> = {};
    const newValue: Record<string, number> = {};
    for (const line of orderedLines) {
      const balance = retailAfterTransfer.get(line.productId)!;
      const product = productById.get(line.productId)!;
      const closingBalance = balance.onHand - line.quantity;
      await tx.update(inventoryBalances).set({ onHand: closingBalance, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
      transactionLines.push({ transactionId: transaction.id, productId: line.productId, warehouseLocationId: input.warehouseLocationId, bucket: "retail", quantityDelta: -line.quantity, openingBalance: balance.onHand, closingBalance });
      const movement = stockTransfers.find((item) => item.productId === line.productId)!;
      responseLines.push({ productId: product.id, productName: product.name, sku: product.sku, quantity: line.quantity, closingRetailBalance: closingBalance, movedFromBuffer: movement.movedFromBuffer, movedFromOnline: movement.movedFromOnline });
      previousValue[product.id] = balance.onHand;
      newValue[product.id] = closingBalance;
    }
    await tx.insert(inventoryTransactionLines).values(transactionLines);
    await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "inventory.retail_dispatched", entityType: "inventory_transaction", entityId: transaction.id, previousValue, newValue, reason: `Retail dispatch to ${input.destination.trim()} (${input.referenceId.trim()})` });
    const stockRotationTransactionId = await rebalanceChannelStock(tx, {
      productIds,
      warehouseLocationId: input.warehouseLocationId,
      actorUsername: input.actorUsername,
      idempotencyKey: `${input.idempotencyKey}:stock-rotation`,
      reason: "Retail dispatch consumed packets; remaining unreserved stock was rebalanced 40/40/20.",
      referenceId: input.referenceId.trim(),
    });
    return {
      transactionId: transaction.id,
      transactionNumber,
      duplicate: false,
      totalQuantity,
      destination: input.destination.trim(),
      stockTransferTransactionId,
      stockRotationTransactionId,
      shopifySync: stockRotationTransactionId || (stockTransferTransactionId && onlinePlans.length) ? "pending" : "not_required",
      lines: responseLines,
    };
  }, { isolationLevel: "serializable" });
}

export async function receiveReturnedStock(input: ReceiveReturnInput): Promise<ReceiveReturnResult> {
  validateReturn(input);
  const db = getDatabase();
  const [existing] = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber, type: inventoryTransactions.type, metadata: inventoryTransactions.metadata })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) {
    if (existing.type !== "return") throw new InventoryCommandError("INVALID_RETURN", "This request key belongs to a different inventory operation.");
    const [line] = await db.select({ quantity: inventoryTransactionLines.quantityDelta, closing: inventoryTransactionLines.closingBalance, bucket: inventoryTransactionLines.bucket })
      .from(inventoryTransactionLines).where(eq(inventoryTransactionLines.transactionId, existing.id)).limit(1);
    const savedChannel = existing.metadata.channel === "shopify" ? "shopify" : "retail";
    const condition = existing.metadata.condition === "damaged" || existing.metadata.condition === "missing" || existing.metadata.condition === "expired" ? existing.metadata.condition : "usable";
    return { transactionId: existing.id, transactionNumber: existing.transactionNumber, duplicate: true, quantity: Math.abs(line?.quantity ?? 0), qcClosingBalance: line?.closing ?? 0, channel: savedChannel, condition, stockBucket: line?.bucket === "qc" || line?.bucket === "damaged" ? line.bucket : null };
  }

  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: products.id, name: products.name }).from(products)
      .where(and(eq(products.id, input.productId), eq(products.active, true))).limit(1);
    if (!product) throw new InventoryCommandError("NOT_FOUND", "The selected product is missing or inactive.");
    const [location] = await tx.select({ id: warehouseLocations.id, name: warehouseLocations.name }).from(warehouseLocations)
      .where(and(eq(warehouseLocations.id, input.warehouseLocationId), eq(warehouseLocations.active, true))).limit(1);
    if (!location) throw new InventoryCommandError("NOT_FOUND", "The selected warehouse location is missing or inactive.");

    const stockBucket = input.condition === "usable" ? input.orderType === "retail" ? "qc" : "qc" : input.condition === "missing" ? null : "damaged";
    if (stockBucket) await tx.insert(inventoryBalances).values({ productId: product.id, warehouseLocationId: location.id, bucket: stockBucket })
      .onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });
    const [balance] = stockBucket ? await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.productId, product.id),
      eq(inventoryBalances.warehouseLocationId, location.id),
      eq(inventoryBalances.bucket, stockBucket),
    )).for("update") : [];
    if (stockBucket && !balance) throw new InventoryCommandError("NOT_FOUND", "The return stock balance could not be created.");

    const closingBalance = balance ? balance.onHand + input.quantity : 0;
    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: "return",
      idempotencyKey: input.idempotencyKey,
      referenceId: input.referenceId.trim(),
      actorUsername: input.actorUsername,
      reason: input.reason.trim(),
      occurredAt: input.receivedAt ?? new Date(),
      metadata: { action: "return_received", channel: input.channel, orderType: input.orderType, courier: input.courier?.trim() || null, rtoCostPaisa: input.rtoCostPaisa ?? null, manifestedAt: input.manifestedAt?.toISOString() ?? null, receivedAt: input.receivedAt?.toISOString() ?? null, condition: input.condition, notes: input.notes?.trim() || null, unit: "individual_packet" },
    }).returning({ id: inventoryTransactions.id });
    if (balance && stockBucket) {
      await tx.update(inventoryBalances).set({ onHand: closingBalance, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
      await tx.insert(inventoryTransactionLines).values({ transactionId: transaction.id, productId: product.id, warehouseLocationId: location.id, bucket: stockBucket, quantityDelta: input.quantity, openingBalance: balance.onHand, closingBalance });
    }
    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "inventory.return_received",
      entityType: "inventory_transaction",
      entityId: transaction.id,
      previousValue: stockBucket && balance ? { [stockBucket]: balance.onHand } : {},
      newValue: stockBucket ? { [stockBucket]: closingBalance } : {},
      reason: `${input.orderType === "shopify" ? "D2C" : "Retail"} return ${input.referenceId.trim()} · ${input.condition}`,
    });
    return { transactionId: transaction.id, transactionNumber, duplicate: false, quantity: stockBucket ? input.quantity : 0, qcClosingBalance: stockBucket === "qc" ? closingBalance : 0, channel: input.channel, condition: input.condition, stockBucket };
  }, { isolationLevel: "serializable" });
}

export async function disposeInventory(input: DisposeInventoryInput): Promise<DisposeInventoryResult> {
  validateDisposal(input);
  const db = getDatabase();
  const [existing] = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber, type: inventoryTransactions.type, metadata: inventoryTransactions.metadata })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) {
    if (existing.type !== "manual_adjustment" || existing.metadata.action !== "disposal") throw new InventoryCommandError("INVALID_DISPOSAL", "This request key belongs to a different inventory operation.");
    const [line] = await db.select({ quantity: inventoryTransactionLines.quantityDelta, closing: inventoryTransactionLines.closingBalance, bucket: inventoryTransactionLines.bucket })
      .from(inventoryTransactionLines).where(eq(inventoryTransactionLines.transactionId, existing.id)).limit(1);
    const [rotation] = await db.select({ id: inventoryTransactions.id }).from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, `${input.idempotencyKey}:stock-rotation`)).limit(1);
    return { transactionId: existing.id, transactionNumber: existing.transactionNumber, duplicate: true, quantity: Math.abs(line?.quantity ?? input.quantity), sourceBucket: line?.bucket ?? input.sourceBucket, closingBalance: line?.closing ?? 0, stockRotationTransactionId: rotation?.id ?? null, shopifySync: rotation || input.sourceBucket === "online" ? "pending" : "not_required" };
  }

  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: products.id, name: products.name }).from(products)
      .where(and(eq(products.id, input.productId), eq(products.active, true))).limit(1);
    if (!product) throw new InventoryCommandError("NOT_FOUND", "The selected product is missing or inactive.");
    const [balance] = await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.productId, input.productId),
      eq(inventoryBalances.warehouseLocationId, input.warehouseLocationId),
      eq(inventoryBalances.bucket, input.sourceBucket),
    )).for("update");
    const available = balance ? balance.onHand - balance.reserved : 0;
    if (!balance || available < input.quantity) throw new InventoryCommandError("INSUFFICIENT_STOCK", `${product.name} has only ${available} unreserved ${input.sourceBucket} packets available.`);

    let mapping: typeof shopifyMappings.$inferSelect | null = null;
    if (input.sourceBucket === "online" && input.shopifyMappingId) {
      [mapping] = await tx.select().from(shopifyMappings).where(and(
        eq(shopifyMappings.id, input.shopifyMappingId),
        eq(shopifyMappings.productId, input.productId),
        eq(shopifyMappings.status, "mapped"),
      )).limit(1);
      if (!mapping) throw new InventoryCommandError("MAPPING_REQUIRED", "The Shopify mapping is missing, inactive, or belongs to another product.");
    }

    const closingBalance = balance.onHand - input.quantity;
    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: "manual_adjustment",
      idempotencyKey: input.idempotencyKey,
      referenceId: input.referenceId.trim(),
      actorUsername: input.actorUsername,
      reason: `Stock disposed: ${input.disposalReason.replaceAll("_", " ")}`,
      metadata: { action: "disposal", sourceBucket: input.sourceBucket, disposalReason: input.disposalReason, expiryDate: input.expiryDate.toISOString(), notes: input.notes?.trim() || null, unit: "individual_packet" },
    }).returning({ id: inventoryTransactions.id });
    if (input.approvalProof) {
      await tx.insert(inventoryReceiptAttachments).values({
        transactionId: transaction.id,
        fileName: `[Manager Approval] ${input.approvalProof.fileName}`,
        contentType: input.approvalProof.contentType,
        fileSize: input.approvalProof.fileSize,
        contentBase64: input.approvalProof.contentBase64,
        uploadedBy: input.actorUsername,
      });
    }
    await tx.update(inventoryBalances).set({ onHand: closingBalance, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() })
      .where(eq(inventoryBalances.id, balance.id));
    await tx.insert(inventoryTransactionLines).values({ transactionId: transaction.id, productId: product.id, warehouseLocationId: input.warehouseLocationId, bucket: input.sourceBucket, quantityDelta: -input.quantity, openingBalance: balance.onHand, closingBalance });
    if (input.sourceBucket === "online" && mapping) {
      await tx.insert(integrationOutbox).values({
        transactionId: transaction.id,
        operation: "shopify_inventory_adjust",
        idempotencyKey: `${input.idempotencyKey}:shopify`,
        payload: { shopifyInventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, quantityDelta: -input.quantity, reason: "correction" },
      });
    }
    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "inventory.stock_disposed",
      entityType: "inventory_transaction",
      entityId: transaction.id,
      previousValue: { [input.sourceBucket]: balance.onHand },
      newValue: { [input.sourceBucket]: closingBalance },
      reason: `${input.quantity} ${product.name} packets disposed: ${input.disposalReason.replaceAll("_", " ")}`,
    });
    const stockRotationTransactionId = await rebalanceChannelStock(tx, {
      productIds: [product.id],
      warehouseLocationId: input.warehouseLocationId,
      actorUsername: input.actorUsername,
      idempotencyKey: `${input.idempotencyKey}:stock-rotation`,
      reason: "Disposed packets were removed and remaining unreserved stock was rebalanced 40/40/20.",
      referenceId: input.referenceId,
    });
    return { transactionId: transaction.id, transactionNumber, duplicate: false, quantity: input.quantity, sourceBucket: input.sourceBucket, closingBalance, stockRotationTransactionId, shopifySync: stockRotationTransactionId || input.sourceBucket === "online" ? "pending" : "not_required" };
  }, { isolationLevel: "serializable" });
}

export async function receiveAndAllocateStock(input: ReceiveStockInput): Promise<ReceiveStockResult> {
  const db = getDatabase();
  validateReceipt(input);
  const existing = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing[0]) {
    const [rotation] = await db.select({ id: inventoryTransactions.id }).from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, `${input.idempotencyKey}:stock-rotation`)).limit(1);
    return { transactionId: existing[0].id, transactionNumber: existing[0].transactionNumber, duplicate: true, receivedQuantity: input.receivedQuantity, stockRotationTransactionId: rotation?.id ?? null, shopifySync: rotation || input.onlineQuantity > 0 ? "pending" : "not_required" };
  }

  if (input.invoiceTransactionId) {
    const [parent] = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.id, input.invoiceTransactionId)).limit(1);
    if (!parent || parent.type !== "stock_received" || parent.actorUsername !== input.actorUsername || parent.referenceId !== input.referenceId || !Number(parent.invoiceValuePaisa) || parent.supplierName !== input.supplierName?.trim() || parent.idempotencyKey.split(":")[0] !== input.idempotencyKey.split(":")[0]) throw new InventoryCommandError("INVALID_RECEIPT", "The first invoice row must be saved before additional rows.");
  }
  if (input.onlineQuantity > 0) {
    const mappings = await db.select().from(shopifyMappings).where(eq(shopifyMappings.productId, input.productId));
    if (!mappings.length) input = { ...input, shopifyMappingId: (await addProductToShopify(input.productId, input.actorUsername)).mappingId };
    else if (mappings.length === 1 && mappings[0].status === "mapped") input = { ...input, shopifyMappingId: mappings[0].id };
    else if (!input.shopifyMappingId || !mappings.some(mapping => mapping.id === input.shopifyMappingId && mapping.status === "mapped")) throw new InventoryCommandError("MAPPING_REQUIRED", "Choose a verified Shopify mapping before splitting stock online.");
  } else input = { ...input, shopifyMappingId: undefined };

  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: products.id, name: products.name }).from(products)
      .where(and(eq(products.id, input.productId), eq(products.active, true))).limit(1);
    if (!product) throw new InventoryCommandError("NOT_FOUND", "The selected product is missing or inactive.");
    if (!isPhysicalUnitProduct(product.name)) throw new InventoryCommandError("INVALID_RECEIPT", "Receive stock against the individual physical unit. Pack listings and bundles do not hold separate stock.");
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
      supplierName: input.supplierName?.trim() || null,
      invoiceValuePaisa: input.invoiceValuePaisa ?? null,
      occurredAt: input.receivedAt,
      metadata: { source: input.source, batchNumber: input.batchNumber, addToShopify: input.addToShopify === true, invoiceTransactionId: input.invoiceTransactionId ?? null },
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
      const onlineBalance = balances.find((balance) => balance.bucket === "online");
      await tx.insert(integrationOutbox).values({ transactionId: transaction.id, operation: "shopify_inventory_adjust", idempotencyKey: `${input.idempotencyKey}:shopify`, payload: { shopifyInventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, quantity: (onlineBalance?.onHand ?? 0) + input.onlineQuantity, reason: "received" } });
    }
    await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "inventory.stock_received", entityType: "inventory_transaction", entityId: transaction.id, previousValue, newValue, reason: input.reason });
    const stockRotationTransactionId = await rebalanceChannelStock(tx, {
      productIds: [input.productId],
      warehouseLocationId: input.warehouseLocationId,
      actorUsername: input.actorUsername,
      idempotencyKey: `${input.idempotencyKey}:stock-rotation`,
      reason: "Newly received packets were combined with existing stock and rebalanced 40/40/20.",
      referenceId: input.referenceId ?? input.batchNumber,
    });
    return { transactionId: transaction.id, transactionNumber, duplicate: false, receivedQuantity: input.receivedQuantity, stockRotationTransactionId, shopifySync: stockRotationTransactionId || input.onlineQuantity > 0 ? "pending" : "not_required" };
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
    const [rotation] = await db.select({ id: inventoryTransactions.id }).from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, `${input.idempotencyKey}:stock-rotation`)).limit(1);
    return {
      transactionId: existing[0].id,
      transactionNumber: existing[0].transactionNumber,
      duplicate: true,
      fromClosingBalance: lines.find((line) => line.bucket === input.fromBucket)?.closing ?? 0,
      toClosingBalance: lines.find((line) => line.bucket === input.toBucket)?.closing ?? 0,
      stockRotationTransactionId: rotation?.id ?? null,
      shopifySync: rotation || input.fromBucket === "online" || input.toBucket === "online" ? "pending" : "not_required",
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
    const stockRotationTransactionId = await rebalanceChannelStock(tx, {
      productIds: [input.productId],
      warehouseLocationId: input.warehouseLocationId,
      actorUsername: input.actorUsername,
      idempotencyKey: `${input.idempotencyKey}:stock-rotation`,
      reason: "Manual channel movement completed; unreserved physical stock was rebalanced 40/40/20.",
      referenceId: input.referenceId ?? input.idempotencyKey,
    });

    return {
      transactionId: transaction.id,
      transactionNumber,
      duplicate: false,
      fromClosingBalance,
      toClosingBalance,
      stockRotationTransactionId,
      shopifySync: stockRotationTransactionId || affectsOnline ? "pending" : "not_required",
    };
  }, { isolationLevel: "serializable" });
}
