import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import {
  auditEvents,
  integrationOutbox,
  inventoryBalances,
  inventoryTransactionLines,
  inventoryTransactions,
  products,
  shopifyMappings,
  shopifyWebhookEvents,
  warehouseLocations,
} from "@/db/schema";
import { getShopifyConfig } from "@/lib/validation/env";
import { inventoryWebhookPayload } from "@/lib/shopify/webhook-payload";
import { targetChannelBalances } from "@/lib/inventory/stock-rotation";
import { isBundleProduct } from "@/lib/inventory/physical-units";
import { bundleComponents } from "./product-bundles";

export const SHOPIFY_WEBHOOK_TOPICS = ["orders/create", "orders/cancelled", "fulfillments/create", "refunds/create"] as const;
export type ShopifyWebhookTopic = (typeof SHOPIFY_WEBHOOK_TOPICS)[number];

interface ShopifyLineItem {
  variant_id?: string | number | null;
  quantity?: number;
  sku?: string | null;
  gift_card?: boolean;
}

interface ShopifyFulfillmentPayload {
  id?: string | number;
  order_id?: string | number;
  location_id?: string | number | null;
  line_items?: ShopifyLineItem[];
}

interface ShopifyOrderPayload {
  id?: string | number;
  line_items?: (ShopifyLineItem & { id?: string | number })[];
  fulfillments?: { line_items?: { id?: string | number; quantity?: number }[] }[];
}

interface ShopifyRefundLineItem {
  quantity?: number;
  location_id?: string | number | null;
  restock_type?: string;
  line_item?: ShopifyLineItem;
}

interface ShopifyRefundPayload {
  id?: string | number;
  order_id?: string | number;
  refund_line_items?: ShopifyRefundLineItem[];
}

interface RawMovement {
  variantId: string;
  shopifyLocationId: string | null;
  variantQuantity: number;
  sku: string | null;
}

interface ResolvedMovement {
  productId: string;
  productName: string;
  sku: string;
  warehouseLocationId: string;
  packetQuantity: number;
  sourceVariants: { variantId: string; inventoryItemId: string; shopifyLocationId: string; variantQuantity: number; packetMultiplier: number }[];
}

export interface ShopifyWebhookResult {
  duplicate: boolean;
  ignored: boolean;
  transactionId: string | null;
  transactionNumber: string | null;
  packetQuantity: number;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : "Shopify webhook processing failed.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function resourceId(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new Error(`Shopify webhook is missing ${label}.`);
  }
  return String(value).trim();
}

function quantity(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("Shopify webhook contains an invalid line-item quantity.");
  return Number(value);
}

function gid(type: "Order" | "ProductVariant" | "Location", value: string | number): string {
  const raw = String(value).trim();
  return raw.startsWith("gid://shopify/") ? raw : `gid://shopify/${type}/${raw}`;
}

function packMultiplier(productName: string): number {
  const match = productName.match(/\bpack\s+of\s+(\d+)\b/i);
  if (!match) return 1;
  const multiplier = Number(match[1]);
  if (!Number.isSafeInteger(multiplier) || multiplier < 1 || multiplier > 1_000) {
    throw new Error(`Invalid pack quantity in Shopify product “${productName}”.`);
  }
  return multiplier;
}

function normalizedLocation(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractMovements(topic: ShopifyWebhookTopic, payload: unknown): {
  externalId: string;
  orderId: string;
  direction: "out" | "in";
  lines: RawMovement[];
} {
  if (!payload || typeof payload !== "object") throw new Error("Shopify webhook payload must be an object.");

  if (topic === "fulfillments/create") {
    const fulfillment = payload as ShopifyFulfillmentPayload;
    const externalId = resourceId(fulfillment.id, "fulfillment id");
    const orderId = resourceId(fulfillment.order_id, "order id");
    return { externalId, orderId, direction: "out", lines: [] };
  }

  if (topic === "orders/create" || topic === "orders/cancelled") {
    const order = payload as ShopifyOrderPayload;
    const orderId = resourceId(order.id, "order id");
    const cancelled = topic === "orders/cancelled";
    const fulfilledByLine = new Map<string, number>();
    if (cancelled) for (const fulfillment of order.fulfillments ?? []) for (const line of fulfillment.line_items ?? []) {
      if (line.id == null) continue;
      const key = String(line.id);
      fulfilledByLine.set(key, (fulfilledByLine.get(key) ?? 0) + (Number.isSafeInteger(line.quantity) ? Number(line.quantity) : 0));
    }
    const lines = (order.line_items ?? []).flatMap((line): RawMovement[] => {
      if (line.gift_card || line.variant_id == null) return [];
      const orderedQuantity = quantity(line.quantity);
      const movementQuantity = cancelled ? Math.max(0, orderedQuantity - (line.id == null ? 0 : fulfilledByLine.get(String(line.id)) ?? 0)) : orderedQuantity;
      if (!movementQuantity) return [];
      return [{
        variantId: gid("ProductVariant", resourceId(line.variant_id, "variant id")),
        shopifyLocationId: null,
        variantQuantity: movementQuantity,
        sku: line.sku?.trim() || null,
      }];
    });
    return { externalId: orderId, orderId, direction: cancelled ? "in" : "out", lines };
  }

  const refund = payload as ShopifyRefundPayload;
  const externalId = resourceId(refund.id, "refund id");
  const orderId = resourceId(refund.order_id, "order id");
  const lines = (refund.refund_line_items ?? []).flatMap((refundLine): RawMovement[] => {
    const restockType = refundLine.restock_type?.toLowerCase();
    // CANCEL is unfulfilled stock: the physical ledger was never reduced, so adding it would double count.
    // Only an explicit fulfilled RETURN adds physical packets back to the command-center ledger.
    if (restockType !== "return") return [];
    const line = refundLine.line_item;
    if (!line || line.gift_card || line.variant_id == null) return [];
    return [{
      variantId: gid("ProductVariant", resourceId(line.variant_id, "variant id")),
      shopifyLocationId: refundLine.location_id == null ? null : gid("Location", resourceId(refundLine.location_id, "location id")),
      variantQuantity: quantity(refundLine.quantity),
      sku: line.sku?.trim() || null,
    }];
  });
  return { externalId, orderId, direction: "in", lines };
}

type MappingRow = {
  productId: string;
  productName: string;
  sku: string;
  shopifyProductId: string;
  shopifyInventoryItemId: string;
  shopifyLocationId: string;
  shopifyLocationName: string;
  status: "mapped" | "missing_sku" | "conflict" | "inactive";
};

async function isMappedVariant(variantId: string): Promise<boolean> {
  const [row] = await getDatabase().select({ id: shopifyMappings.id }).from(shopifyMappings).where(eq(shopifyMappings.shopifyVariantId, variantId)).limit(1);
  return Boolean(row);
}

async function variantMapping(variantId: string, locationId: string | null): Promise<MappingRow> {
  const db = getDatabase();
  const rows = await db.select({
    productId: shopifyMappings.productId,
    productName: products.name,
    sku: products.sku,
    shopifyProductId: shopifyMappings.shopifyProductId,
    shopifyInventoryItemId: shopifyMappings.shopifyInventoryItemId,
    shopifyLocationId: shopifyMappings.shopifyLocationId,
    shopifyLocationName: shopifyMappings.shopifyLocationName,
    status: shopifyMappings.status,
  }).from(shopifyMappings)
    .innerJoin(products, eq(products.id, shopifyMappings.productId))
    .where(eq(shopifyMappings.shopifyVariantId, variantId));
  const locationRows = locationId ? rows.filter((row) => row.shopifyLocationId === locationId) : rows;
  if (locationId && !locationRows.length) throw new Error(`Shopify variant ${variantId} is not mapped at location ${locationId}.`);
  const candidates = locationRows;
  const active = candidates.filter((row) => row.status === "mapped" || row.status === "conflict");
  if (!active.length) throw new Error(`Shopify variant ${variantId} is not mapped in the command center.`);
  const unique = new Map(active.map((row) => [`${row.productId}:${row.shopifyLocationId}`, row]));
  if (unique.size > 1 && !locationId) throw new Error(`Shopify variant ${variantId} is mapped to more than one location; the webhook did not specify one.`);
  return [...unique.values()][0];
}

async function basePacketProduct(mapping: MappingRow): Promise<{ productId: string; productName: string; sku: string; multiplier: number }> {
  const multiplier = packMultiplier(mapping.productName);
  if (multiplier === 1) return { productId: mapping.productId, productName: mapping.productName, sku: mapping.sku, multiplier };

  const db = getDatabase();
  const rows = await db.select({
    productId: shopifyMappings.productId,
    productName: products.name,
    sku: products.sku,
    shopifyLocationId: shopifyMappings.shopifyLocationId,
    status: shopifyMappings.status,
  }).from(shopifyMappings)
    .innerJoin(products, eq(products.id, shopifyMappings.productId))
    .where(eq(shopifyMappings.shopifyProductId, mapping.shopifyProductId));
  const candidates = rows.filter((row) =>
    (row.status === "mapped" || row.status === "conflict") &&
    packMultiplier(row.productName) === 1 &&
    row.productName.match(/\bpack\s+of\s+1\b/i),
  );
  const sameShopifyLocation = candidates.filter((row) => row.shopifyLocationId === mapping.shopifyLocationId);
  const preferred = sameShopifyLocation.length ? sameShopifyLocation : candidates;
  const unique = new Map(preferred.map((row) => [row.productId, row]));
  if (unique.size !== 1) {
    throw new Error(`Shopify variant “${mapping.productName}” needs one Pack of 1 mapping before packet inventory can be updated safely.`);
  }
  const base = [...unique.values()][0];
  return { productId: base.productId, productName: base.productName, sku: base.sku, multiplier };
}

async function warehouseLocationId(productId: string, shopifyLocationName: string): Promise<string> {
  const db = getDatabase();
  const balances = await db.select({
    id: inventoryBalances.warehouseLocationId,
    code: warehouseLocations.code,
    name: warehouseLocations.name,
  }).from(inventoryBalances)
    .innerJoin(warehouseLocations, eq(warehouseLocations.id, inventoryBalances.warehouseLocationId))
    .where(and(eq(inventoryBalances.productId, productId), eq(inventoryBalances.bucket, "online"), eq(warehouseLocations.active, true)));
  if (balances.length === 1) return balances[0].id;
  const shopifyName = normalizedLocation(shopifyLocationName);
  const matchedBalances = balances.filter((row) => normalizedLocation(row.name) === shopifyName || normalizedLocation(row.code) === shopifyName);
  if (matchedBalances.length === 1) return matchedBalances[0].id;

  const locations = await db.select({ id: warehouseLocations.id, code: warehouseLocations.code, name: warehouseLocations.name })
    .from(warehouseLocations).where(eq(warehouseLocations.active, true));
  const matchedLocations = locations.filter((row) => normalizedLocation(row.name) === shopifyName || normalizedLocation(row.code) === shopifyName);
  if (matchedLocations.length === 1) return matchedLocations[0].id;
  if (!balances.length && locations.length === 1) return locations[0].id;
  throw new Error(`Cannot safely match Shopify location “${shopifyLocationName}” to one warehouse location.`);
}

// A combo consumes its recipe's individual packets; other listings consume their Pack of 1 base product.
async function packetProducts(mapping: MappingRow): Promise<{ productId: string; productName: string; sku: string; multiplier: number }[]> {
  const components = await bundleComponents(mapping.productId);
  if (components.length) {
    const combos = packMultiplier(mapping.productName);
    return components.map((component) => ({ productId: component.productId, productName: component.name, sku: component.sku, multiplier: component.quantity * combos }));
  }
  if (isBundleProduct(mapping.productName)) throw new Error(`Combo “${mapping.productName}” has no contents yet. Add its individual packets in Settings → Combo contents.`);
  return [await basePacketProduct(mapping)];
}

async function resolveMovements(lines: RawMovement[]): Promise<ResolvedMovement[]> {
  const aggregate = new Map<string, ResolvedMovement>();
  for (const line of lines) {
    // The catalog sync skips Shopify variants without a SKU, so they are untracked here too.
    if (!line.sku && !await isMappedVariant(line.variantId)) continue;
    const mapping = await variantMapping(line.variantId, line.shopifyLocationId);
    const parts = await packetProducts(mapping);
    for (const [index, base] of parts.entries()) {
      const locationId = await warehouseLocationId(base.productId, mapping.shopifyLocationName);
      const packetQuantity = line.variantQuantity * base.multiplier;
      if (!Number.isSafeInteger(packetQuantity)) throw new Error(`Packet quantity is too large for Shopify variant ${line.variantId}.`);
      // Attach the Shopify listing once, so returns quarantine a combo listing a single time.
      const sourceVariants = index === 0 ? [{ variantId: line.variantId, inventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, variantQuantity: line.variantQuantity, packetMultiplier: base.multiplier }] : [];
      const key = `${base.productId}:${locationId}`;
      const current = aggregate.get(key);
      if (current) {
        current.packetQuantity += packetQuantity;
        current.sourceVariants.push(...sourceVariants);
      } else {
        aggregate.set(key, { productId: base.productId, productName: base.productName, sku: base.sku, warehouseLocationId: locationId, packetQuantity, sourceVariants });
      }
    }
  }
  return [...aggregate.values()].sort((left, right) => `${left.productId}:${left.warehouseLocationId}`.localeCompare(`${right.productId}:${right.warehouseLocationId}`));
}

async function applyInventoryMovement(
  topic: ShopifyWebhookTopic,
  externalId: string,
  orderId: string,
  direction: "out" | "in",
  movements: ResolvedMovement[],
): Promise<ShopifyWebhookResult> {
  if (!movements.length) return { duplicate: false, ignored: true, transactionId: null, transactionNumber: null, packetQuantity: 0 };
  const db = getDatabase();
  const idempotencyKey = topic === "orders/create"
    ? `shopify-order:create:${orderId}`
    : topic === "orders/cancelled"
      ? `shopify-order:cancel:${orderId}`
      : `shopify-${direction === "out" ? "fulfillment" : "refund"}:${externalId}`;
  const [existing] = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, idempotencyKey)).limit(1);
  if (existing) {
    return { duplicate: true, ignored: false, transactionId: existing.id, transactionNumber: existing.transactionNumber, packetQuantity: movements.reduce((sum, line) => sum + line.packetQuantity, 0) };
  }

  return db.transaction(async (tx) => {
    const targetBucket = topic === "orders/cancelled" ? "online" as const : direction === "out" ? "online" as const : "qc" as const;
    const channelSale = topic === "orders/create" || topic === "orders/cancelled";
    const stockBuckets = channelSale ? ["online", "retail", "buffer"] as const : [targetBucket] as const;
    await tx.insert(inventoryBalances).values(movements.map((movement) => ({
      productId: movement.productId,
      warehouseLocationId: movement.warehouseLocationId,
      bucket: stockBuckets[0],
    }))).onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });
    if (channelSale) await tx.insert(inventoryBalances).values(movements.flatMap((movement) => stockBuckets.slice(1).map((bucket) => ({ productId: movement.productId, warehouseLocationId: movement.warehouseLocationId, bucket }))))
      .onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });
    const productIds = [...new Set(movements.map((movement) => movement.productId))];
    const warehouseIds = [...new Set(movements.map((movement) => movement.warehouseLocationId))];
    const balances = await tx.select().from(inventoryBalances).where(and(
      inArray(inventoryBalances.productId, productIds),
      inArray(inventoryBalances.warehouseLocationId, warehouseIds),
      inArray(inventoryBalances.bucket, [...stockBuckets]),
    )).orderBy(inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket).for("update");
    const balanceByScope = new Map(balances.map((balance) => [`${balance.productId}:${balance.warehouseLocationId}:${balance.bucket}`, balance]));

    for (const movement of movements) {
      const balance = balanceByScope.get(`${movement.productId}:${movement.warehouseLocationId}:${targetBucket}`);
      if (!balance) throw new Error(`Online balance could not be created for ${movement.productName}.`);
      if (direction === "out" && balance.onHand - balance.reserved < movement.packetQuantity) {
        throw new Error(`${movement.productName} has only ${balance.onHand - balance.reserved} unreserved Online packets; Shopify shipped ${movement.packetQuantity}.`);
      }
    }

    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const totalPackets = movements.reduce((sum, movement) => sum + movement.packetQuantity, 0);
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: direction === "out" ? "shopify_sale" : topic === "orders/cancelled" ? "shopify_reconciliation" : "return",
      idempotencyKey,
      referenceId: externalId,
      shopifyOrderId: gid("Order", orderId),
      actorUsername: "shopify-webhook",
      reason: topic === "orders/create" ? "Shopify order received; Online stock committed" : topic === "orders/cancelled" ? "Shopify order cancelled; unfulfilled Online stock restored" : direction === "out" ? "Shopify fulfillment shipped" : "Shopify returned items received into QC",
      metadata: { topic, externalId, totalPackets, unit: "individual_packet", targetBucket, movements },
    }).returning({ id: inventoryTransactions.id });

    const ledgerLines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
    const previousValue: Record<string, number> = {};
    const newValue: Record<string, number> = {};
    for (const movement of movements) {
      const balance = balanceByScope.get(`${movement.productId}:${movement.warehouseLocationId}:${targetBucket}`)!;
      const delta = direction === "out" ? -movement.packetQuantity : movement.packetQuantity;
      const closing = balance.onHand + delta;
      await tx.update(inventoryBalances).set({
        onHand: closing,
        version: sql`${inventoryBalances.version} + 1`,
        updatedAt: new Date(),
      }).where(eq(inventoryBalances.id, balance.id));
      ledgerLines.push({
        transactionId: transaction.id,
        productId: movement.productId,
        warehouseLocationId: movement.warehouseLocationId,
        bucket: targetBucket,
        quantityDelta: delta,
        openingBalance: balance.onHand,
        closingBalance: closing,
      });
      const scope = `${movement.productId}:${movement.warehouseLocationId}:${targetBucket}`;
      previousValue[scope] = balance.onHand;
      newValue[scope] = closing;
    }
    const rotationTargets = new Map<string, { movement: ResolvedMovement; target: ReturnType<typeof targetChannelBalances> }>();
    if (channelSale) {
      for (const movement of movements) {
        const scope = `${movement.productId}:${movement.warehouseLocationId}`;
        const rows = stockBuckets.map((bucket) => {
          const balance = balanceByScope.get(`${scope}:${bucket}`)!;
          const orderDelta = bucket === targetBucket ? (direction === "out" ? -movement.packetQuantity : movement.packetQuantity) : 0;
          return { bucket: bucket as "online" | "retail" | "buffer", onHand: balance.onHand + orderDelta, reserved: balance.reserved };
        });
        rotationTargets.set(scope, { movement, target: targetChannelBalances(rows) });
      }
      for (const [scope, { movement, target }] of rotationTargets) {
        for (const bucket of stockBuckets) {
          const balance = balanceByScope.get(`${scope}:${bucket}`)!;
          const afterOrder = balance.onHand + (bucket === targetBucket ? (direction === "out" ? -movement.packetQuantity : movement.packetQuantity) : 0);
          const closing = target[bucket as "online" | "retail" | "buffer"];
          if (closing === afterOrder) continue;
          await tx.update(inventoryBalances).set({ onHand: closing, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
          ledgerLines.push({ transactionId: transaction.id, productId: movement.productId, warehouseLocationId: movement.warehouseLocationId, bucket, quantityDelta: closing - afterOrder, openingBalance: afterOrder, closingBalance: closing });
          const previousKey = `${scope}:${bucket}`;
          previousValue[previousKey] ??= balance.onHand;
          newValue[previousKey] = closing;
        }
      }
    }
    await tx.insert(inventoryTransactionLines).values(ledgerLines);
    if (channelSale) {
      const baseMappings = await tx.select({ productId: shopifyMappings.productId, itemId: shopifyMappings.shopifyInventoryItemId, locationId: shopifyMappings.shopifyLocationId })
        .from(shopifyMappings).where(and(inArray(shopifyMappings.productId, movements.map((movement) => movement.productId)), eq(shopifyMappings.status, "mapped")));
      const mappingByProduct = new Map<string, typeof baseMappings[number]>();
      for (const mapping of baseMappings) if (!mappingByProduct.has(mapping.productId)) mappingByProduct.set(mapping.productId, mapping);
      const targets = [...rotationTargets.values()].flatMap(({ movement, target }) => {
        const mapping = mappingByProduct.get(movement.productId);
        const scope = `${movement.productId}:${movement.warehouseLocationId}`;
        const oldOnline = balanceByScope.get(`${scope}:online`)?.onHand ?? 0;
        return mapping && target.online !== oldOnline ? [{ mapping, quantity: target.online }] : [];
      });
      if (targets.length) {
        const itemIds = new Set(targets.map(({ mapping }) => mapping.itemId));
        const pendingJobs = await tx.select({ id: integrationOutbox.id, payload: integrationOutbox.payload }).from(integrationOutbox).where(and(eq(integrationOutbox.operation, "shopify_inventory_adjust"), inArray(integrationOutbox.status, ["pending", "failed"])));
        const superseded = pendingJobs.filter((job) => typeof job.payload.shopifyInventoryItemId === "string" && itemIds.has(job.payload.shopifyInventoryItemId)).map((job) => job.id);
        if (superseded.length) await tx.update(integrationOutbox).set({ status: "cancelled", lockedAt: null, completedAt: new Date(), lastError: "Superseded by an absolute Online quantity after Shopify order movement.", updatedAt: new Date() }).where(inArray(integrationOutbox.id, superseded));
        await tx.insert(integrationOutbox).values(targets.map(({ mapping, quantity: targetQuantity }, index) => ({
          transactionId: transaction.id,
          operation: "shopify_inventory_adjust",
          idempotencyKey: `${idempotencyKey}:online-target:${index}`,
          payload: { shopifyInventoryItemId: mapping.itemId, shopifyLocationId: mapping.locationId, quantity: targetQuantity, reason: "correction" },
        })));
      }
    }
    if (direction === "in") {
      const quarantine = new Map<string, { inventoryItemId: string; locationId: string; quantity: number }>();
      for (const movement of movements) {
        for (const variant of movement.sourceVariants) {
          const key = `${variant.inventoryItemId}:${variant.shopifyLocationId}`;
          const current = quarantine.get(key);
          if (current) current.quantity += variant.variantQuantity;
          else quarantine.set(key, { inventoryItemId: variant.inventoryItemId, locationId: variant.shopifyLocationId, quantity: variant.variantQuantity });
        }
      }
      await tx.insert(integrationOutbox).values([...quarantine.values()].map((item, index) => ({
        transactionId: transaction.id,
        operation: "shopify_inventory_adjust",
        idempotencyKey: `${idempotencyKey}:quarantine:${index}`,
        payload: { shopifyInventoryItemId: item.inventoryItemId, shopifyLocationId: item.locationId, quantityDelta: -item.quantity, reason: "correction" },
      })));
    }
    await tx.insert(auditEvents).values({
      actorUsername: "shopify-webhook",
      action: topic === "orders/create" ? "inventory.shopify_order_received" : topic === "orders/cancelled" ? "inventory.shopify_order_cancelled" : direction === "out" ? "inventory.shopify_fulfilled" : "inventory.shopify_return_quarantined",
      entityType: "inventory_transaction",
      entityId: transaction.id,
      previousValue,
      newValue,
      reason: `Verified Shopify ${topic} webhook`,
    });
    return { duplicate: false, ignored: false, transactionId: transaction.id, transactionNumber, packetQuantity: totalPackets };
  }, { isolationLevel: "serializable" });
}

export function verifyShopifyWebhook(rawBody: Buffer, suppliedSignature: string | null): boolean {
  if (!suppliedSignature) return false;
  const expected = createHmac("sha256", getShopifyConfig().clientSecret).update(rawBody).digest("base64");
  const supplied = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

export function shopifyPayloadHash(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export async function processShopifyWebhook(input: {
  eventId: string;
  topic: ShopifyWebhookTopic;
  payloadHash: string;
  payload: unknown;
}): Promise<ShopifyWebhookResult> {
  const db = getDatabase();
  await db.insert(shopifyWebhookEvents).values({
    shopifyEventId: input.eventId,
    topic: input.topic,
    payloadHash: input.payloadHash,
    payload: inventoryWebhookPayload(input.payload),
  }).onConflictDoNothing({ target: shopifyWebhookEvents.shopifyEventId });
  const [event] = await db.select().from(shopifyWebhookEvents).where(eq(shopifyWebhookEvents.shopifyEventId, input.eventId)).limit(1);
  if (!event) throw new Error("Shopify webhook event could not be recorded.");
  if (event.topic !== input.topic || event.payloadHash !== input.payloadHash) throw new Error("A Shopify event id was reused with a different topic or payload.");
  if (event.status === "succeeded") return { duplicate: true, ignored: false, transactionId: null, transactionNumber: null, packetQuantity: 0 };

  const staleBefore = new Date(Date.now() - 10 * 60 * 1_000);
  const [claimed] = await db.update(shopifyWebhookEvents).set({ status: "processing", lastError: null, lockedAt: new Date() }).where(and(
    eq(shopifyWebhookEvents.id, event.id),
    or(
      inArray(shopifyWebhookEvents.status, ["pending", "failed"]),
      and(eq(shopifyWebhookEvents.status, "processing"), sql`coalesce(${shopifyWebhookEvents.lockedAt}, ${shopifyWebhookEvents.createdAt}) < ${staleBefore.toISOString()}::timestamptz`),
    ),
  )).returning({ id: shopifyWebhookEvents.id });
  if (!claimed) return { duplicate: true, ignored: false, transactionId: null, transactionNumber: null, packetQuantity: 0 };

  try {
    if ((input.payload as { test?: boolean })?.test === true) {
      await db.update(shopifyWebhookEvents).set({ status: "succeeded", processedAt: new Date(), payload: null }).where(eq(shopifyWebhookEvents.id, event.id));
      return { duplicate: false, ignored: true, transactionId: null, transactionNumber: null, packetQuantity: 0 };
    }
    const extracted = extractMovements(input.topic, input.payload);
    if (input.topic === "orders/cancelled") {
      const [orderReceipt] = await db.select({ id: inventoryTransactions.id }).from(inventoryTransactions)
        .where(eq(inventoryTransactions.idempotencyKey, `shopify-order:create:${extracted.orderId}`)).limit(1);
      if (!orderReceipt) {
        await db.insert(inventoryTransactions).values({
          transactionNumber: `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`,
          type: "shopify_reconciliation",
          idempotencyKey: `shopify-order:cancel:${extracted.orderId}`,
          referenceId: extracted.orderId,
          shopifyOrderId: gid("Order", extracted.orderId),
          actorUsername: "shopify-webhook",
          reason: "Shopify order cancelled before inventory receipt was recorded",
          metadata: { topic: input.topic, cancelledBeforeReceipt: true },
        }).onConflictDoNothing({ target: inventoryTransactions.idempotencyKey });
        await db.update(shopifyWebhookEvents).set({ status: "succeeded", processedAt: new Date(), lastError: null, payload: null, lockedAt: null }).where(eq(shopifyWebhookEvents.id, event.id));
        return { duplicate: false, ignored: true, transactionId: null, transactionNumber: null, packetQuantity: 0 };
      }
    }
    if (input.topic === "orders/create") {
      const [cancellation] = await db.select({ id: inventoryTransactions.id }).from(inventoryTransactions)
        .where(eq(inventoryTransactions.idempotencyKey, `shopify-order:cancel:${extracted.orderId}`)).limit(1);
      if (cancellation) {
        await db.update(shopifyWebhookEvents).set({ status: "succeeded", processedAt: new Date(), lastError: null, payload: null, lockedAt: null }).where(eq(shopifyWebhookEvents.id, event.id));
        return { duplicate: false, ignored: true, transactionId: null, transactionNumber: null, packetQuantity: 0 };
      }
    }
    const movements = await resolveMovements(extracted.lines);
    const result = await applyInventoryMovement(input.topic, extracted.externalId, extracted.orderId, extracted.direction, movements);
    await db.update(shopifyWebhookEvents).set({ status: "succeeded", processedAt: new Date(), lastError: null, payload: null, lockedAt: null })
      .where(eq(shopifyWebhookEvents.id, event.id));
    return result;
  } catch (error) {
    await db.update(shopifyWebhookEvents).set({ status: "failed", processedAt: new Date(), lastError: cleanError(error), lockedAt: null })
      .where(eq(shopifyWebhookEvents.id, event.id));
    throw error;
  }
}


// True when a failed event is saved with its payload, so the retry loop will apply it later.
export async function isQueuedForRetry(eventId: string): Promise<boolean> {
  const [saved] = await getDatabase().select({ status: shopifyWebhookEvents.status }).from(shopifyWebhookEvents)
    .where(and(eq(shopifyWebhookEvents.shopifyEventId, eventId), sql`${shopifyWebhookEvents.payload} is not null`)).limit(1);
  return saved?.status === "failed";
}

export async function retryShopifyWebhookEvents(limit = 20) {
  const db = getDatabase();
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  const events = await db.select().from(shopifyWebhookEvents).where(and(
    sql`${shopifyWebhookEvents.payload} is not null`,
    or(inArray(shopifyWebhookEvents.status, ["pending", "failed"]),
      and(eq(shopifyWebhookEvents.status, "processing"), sql`coalesce(${shopifyWebhookEvents.lockedAt}, ${shopifyWebhookEvents.createdAt}) < ${staleBefore.toISOString()}::timestamptz`)),
  )).orderBy(sql`${shopifyWebhookEvents.processedAt} asc nulls first`, shopifyWebhookEvents.createdAt).limit(limit);
  let succeeded = 0, failed = 0;
  for (const event of events) {
    try {
      await processShopifyWebhook({ eventId: event.shopifyEventId, topic: event.topic as ShopifyWebhookTopic, payloadHash: event.payloadHash, payload: event.payload });
      succeeded++;
    } catch { failed++; }
  }
  return { examined: events.length, succeeded, failed };
}
