import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
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

export const SHOPIFY_WEBHOOK_TOPICS = ["fulfillments/create", "refunds/create"] as const;
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
    const fallbackLocation = fulfillment.location_id == null ? null : gid("Location", resourceId(fulfillment.location_id, "location id"));
    const lines = (fulfillment.line_items ?? []).flatMap((line): RawMovement[] => {
      if (line.gift_card || line.variant_id == null) return [];
      return [{
        variantId: gid("ProductVariant", resourceId(line.variant_id, "variant id")),
        shopifyLocationId: fallbackLocation,
        variantQuantity: quantity(line.quantity),
        sku: line.sku?.trim() || null,
      }];
    });
    return { externalId, orderId, direction: "out", lines };
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

async function resolveMovements(lines: RawMovement[]): Promise<ResolvedMovement[]> {
  const aggregate = new Map<string, ResolvedMovement>();
  for (const line of lines) {
    const mapping = await variantMapping(line.variantId, line.shopifyLocationId);
    const base = await basePacketProduct(mapping);
    const locationId = await warehouseLocationId(base.productId, mapping.shopifyLocationName);
    const packetQuantity = line.variantQuantity * base.multiplier;
    if (!Number.isSafeInteger(packetQuantity)) throw new Error(`Packet quantity is too large for Shopify variant ${line.variantId}.`);
    const key = `${base.productId}:${locationId}`;
    const current = aggregate.get(key);
    if (current) {
      current.packetQuantity += packetQuantity;
      current.sourceVariants.push({ variantId: line.variantId, inventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, variantQuantity: line.variantQuantity, packetMultiplier: base.multiplier });
    } else {
      aggregate.set(key, {
        productId: base.productId,
        productName: base.productName,
        sku: base.sku,
        warehouseLocationId: locationId,
        packetQuantity,
        sourceVariants: [{ variantId: line.variantId, inventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, variantQuantity: line.variantQuantity, packetMultiplier: base.multiplier }],
      });
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
  const idempotencyKey = `shopify-${direction === "out" ? "fulfillment" : "refund"}:${externalId}`;
  const [existing] = await db.select({ id: inventoryTransactions.id, transactionNumber: inventoryTransactions.transactionNumber })
    .from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, idempotencyKey)).limit(1);
  if (existing) {
    return { duplicate: true, ignored: false, transactionId: existing.id, transactionNumber: existing.transactionNumber, packetQuantity: movements.reduce((sum, line) => sum + line.packetQuantity, 0) };
  }

  return db.transaction(async (tx) => {
    const targetBucket = direction === "out" ? "online" as const : "qc" as const;
    await tx.insert(inventoryBalances).values(movements.map((movement) => ({
      productId: movement.productId,
      warehouseLocationId: movement.warehouseLocationId,
      bucket: targetBucket,
    }))).onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });
    const productIds = [...new Set(movements.map((movement) => movement.productId))];
    const warehouseIds = [...new Set(movements.map((movement) => movement.warehouseLocationId))];
    const balances = await tx.select().from(inventoryBalances).where(and(
      inArray(inventoryBalances.productId, productIds),
      inArray(inventoryBalances.warehouseLocationId, warehouseIds),
      eq(inventoryBalances.bucket, targetBucket),
    )).orderBy(inventoryBalances.productId, inventoryBalances.warehouseLocationId).for("update");
    const balanceByScope = new Map(balances.map((balance) => [`${balance.productId}:${balance.warehouseLocationId}`, balance]));

    for (const movement of movements) {
      const balance = balanceByScope.get(`${movement.productId}:${movement.warehouseLocationId}`);
      if (!balance) throw new Error(`Online balance could not be created for ${movement.productName}.`);
      if (direction === "out" && balance.onHand - balance.reserved < movement.packetQuantity) {
        throw new Error(`${movement.productName} has only ${balance.onHand - balance.reserved} unreserved Online packets; Shopify shipped ${movement.packetQuantity}.`);
      }
    }

    const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const totalPackets = movements.reduce((sum, movement) => sum + movement.packetQuantity, 0);
    const [transaction] = await tx.insert(inventoryTransactions).values({
      transactionNumber,
      type: direction === "out" ? "shopify_sale" : "return",
      idempotencyKey,
      referenceId: externalId,
      shopifyOrderId: gid("Order", orderId),
      actorUsername: "shopify-webhook",
      reason: direction === "out" ? "Shopify fulfillment shipped" : "Shopify returned items received into QC",
      metadata: { topic, externalId, totalPackets, unit: "individual_packet", targetBucket, movements },
    }).returning({ id: inventoryTransactions.id });

    const ledgerLines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
    const previousValue: Record<string, number> = {};
    const newValue: Record<string, number> = {};
    for (const movement of movements) {
      const balance = balanceByScope.get(`${movement.productId}:${movement.warehouseLocationId}`)!;
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
    await tx.insert(inventoryTransactionLines).values(ledgerLines);
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
      action: direction === "out" ? "inventory.shopify_fulfilled" : "inventory.shopify_return_quarantined",
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
  }).onConflictDoNothing({ target: shopifyWebhookEvents.shopifyEventId });
  const [event] = await db.select().from(shopifyWebhookEvents).where(eq(shopifyWebhookEvents.shopifyEventId, input.eventId)).limit(1);
  if (!event) throw new Error("Shopify webhook event could not be recorded.");
  if (event.topic !== input.topic || event.payloadHash !== input.payloadHash) throw new Error("A Shopify event id was reused with a different topic or payload.");
  if (event.status === "succeeded") return { duplicate: true, ignored: false, transactionId: null, transactionNumber: null, packetQuantity: 0 };

  const staleBefore = new Date(Date.now() - 10 * 60 * 1_000);
  const [claimed] = await db.update(shopifyWebhookEvents).set({ status: "processing", lastError: null }).where(and(
    eq(shopifyWebhookEvents.id, event.id),
    or(
      inArray(shopifyWebhookEvents.status, ["pending", "failed"]),
      and(eq(shopifyWebhookEvents.status, "processing"), lt(shopifyWebhookEvents.createdAt, staleBefore)),
    ),
  )).returning({ id: shopifyWebhookEvents.id });
  if (!claimed) return { duplicate: true, ignored: false, transactionId: null, transactionNumber: null, packetQuantity: 0 };

  try {
    const extracted = extractMovements(input.topic, input.payload);
    const movements = await resolveMovements(extracted.lines);
    const result = await applyInventoryMovement(input.topic, extracted.externalId, extracted.orderId, extracted.direction, movements);
    await db.update(shopifyWebhookEvents).set({ status: "succeeded", processedAt: new Date(), lastError: null })
      .where(eq(shopifyWebhookEvents.id, event.id));
    return result;
  } catch (error) {
    await db.update(shopifyWebhookEvents).set({ status: "failed", processedAt: new Date(), lastError: cleanError(error) })
      .where(eq(shopifyWebhookEvents.id, event.id));
    throw error;
  }
}
