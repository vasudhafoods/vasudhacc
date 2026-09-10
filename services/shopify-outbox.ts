import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { integrationOutbox } from "@/db/schema";
import { shopifyGraphQL } from "@/lib/shopify/client";
import { ShopifyGraphQLError, ShopifyUserError } from "@/lib/shopify/errors";
import { INVENTORY_ADJUST_QUANTITIES_MUTATION } from "@/lib/shopify/queries";
import type { ShopifySyncStatus } from "@/types/warehouse";

const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BATCH_SIZE = 50;

interface InventoryAdjustmentResponse {
  inventoryAdjustQuantities: {
    inventoryAdjustmentGroup: { id: string; createdAt: string } | null;
    userErrors: { code?: string; field?: string[]; message: string }[];
  };
}

export interface ShopifyOutboxResult {
  examined: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface ProcessShopifyOutboxOptions {
  force?: boolean;
  limit?: number;
  transactionId?: string;
}

function retryAt(attempt: number, now: Date): Date {
  const delayMinutes = Math.min(24 * 60, 2 ** Math.min(Math.max(attempt - 1, 0), 10));
  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Shopify inventory synchronization failed.";
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function payloadString(payload: Record<string, unknown>, key: string, prefix: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.startsWith(prefix)) throw new Error(`Outbox payload has an invalid ${key}.`);
  return value;
}

function adjustmentPayload(payload: Record<string, unknown>) {
  const quantityDelta = payload.quantityDelta;
  if (!Number.isSafeInteger(quantityDelta) || Number(quantityDelta) === 0) throw new Error("Outbox payload has an invalid quantityDelta.");
  return {
    inventoryItemId: payloadString(payload, "shopifyInventoryItemId", "gid://shopify/InventoryItem/"),
    locationId: payloadString(payload, "shopifyLocationId", "gid://shopify/Location/"),
    quantityDelta: Number(quantityDelta),
  };
}

function remoteIdempotencyKey(jobId: string, payload: Record<string, unknown>): string {
  const saved = payload.shopifyIdempotencyKey;
  return typeof saved === "string" && /^[0-9a-f-]{36}$/i.test(saved) ? saved : jobId;
}

function shouldRotateRemoteKey(error: unknown): boolean {
  if (!(error instanceof ShopifyUserError)) return false;
  return !error.errorCodes.includes("IDEMPOTENCY_CONCURRENT_REQUEST");
}

async function executeAdjustment(job: typeof integrationOutbox.$inferSelect): Promise<void> {
  if (job.operation !== "shopify_inventory_adjust") throw new Error(`Unsupported outbox operation: ${job.operation}.`);
  const adjustment = adjustmentPayload(job.payload);
  const response = await shopifyGraphQL<InventoryAdjustmentResponse>(INVENTORY_ADJUST_QUANTITIES_MUTATION, {
    input: {
      reason: "correction",
      name: "available",
      referenceDocumentUri: `gid://vasudha-command-center/InventoryTransaction/${job.transactionId}`,
      changes: [{
        delta: adjustment.quantityDelta,
        inventoryItemId: adjustment.inventoryItemId,
        locationId: adjustment.locationId,
      }],
    },
    idempotencyKey: remoteIdempotencyKey(job.id, job.payload),
  });
  if (!response.inventoryAdjustQuantities.inventoryAdjustmentGroup) {
    throw new ShopifyGraphQLError("Shopify did not confirm the inventory adjustment.");
  }
}

export async function processShopifyOutbox(options: ProcessShopifyOutboxOptions = {}): Promise<ShopifyOutboxResult> {
  const db = getDatabase();
  const now = new Date();
  const limit = Math.min(MAX_BATCH_SIZE, Math.max(1, Math.trunc(options.limit ?? 25)));
  const staleBefore = new Date(now.getTime() - PROCESSING_TIMEOUT_MS);

  await db.update(integrationOutbox).set({
    status: "failed",
    lockedAt: null,
    nextAttemptAt: now,
    lastError: "Previous Shopify synchronization attempt timed out and was released for retry.",
    updatedAt: now,
  }).where(and(
    eq(integrationOutbox.status, "processing"),
    sql`${integrationOutbox.lockedAt} is null or ${integrationOutbox.lockedAt} < ${staleBefore}`,
  ));

  const dueCondition = options.force ? undefined : lte(integrationOutbox.nextAttemptAt, now);
  const candidates = await db.select().from(integrationOutbox).where(and(
    inArray(integrationOutbox.status, ["pending", "failed"]),
    options.transactionId ? eq(integrationOutbox.transactionId, options.transactionId) : undefined,
    dueCondition,
  )).orderBy(asc(integrationOutbox.nextAttemptAt), asc(integrationOutbox.createdAt)).limit(limit);

  const result: ShopifyOutboxResult = { examined: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const candidate of candidates) {
    const claimedAt = new Date();
    const [job] = await db.update(integrationOutbox).set({
      status: "processing",
      attempts: sql`${integrationOutbox.attempts} + 1`,
      lockedAt: claimedAt,
      lastError: null,
      updatedAt: claimedAt,
    }).where(and(
      eq(integrationOutbox.id, candidate.id),
      inArray(integrationOutbox.status, ["pending", "failed"]),
    )).returning();
    if (!job) continue;
    result.examined += 1;

    if (job.operation !== "shopify_inventory_adjust") {
      await db.update(integrationOutbox).set({
        status: "cancelled",
        lockedAt: null,
        completedAt: new Date(),
        lastError: `Unsupported outbox operation: ${job.operation}.`,
        updatedAt: new Date(),
      }).where(and(eq(integrationOutbox.id, job.id), eq(integrationOutbox.status, "processing")));
      result.cancelled += 1;
      continue;
    }

    try {
      await executeAdjustment(job);
      const completedAt = new Date();
      await db.update(integrationOutbox).set({
        status: "succeeded",
        lockedAt: null,
        completedAt,
        lastError: null,
        updatedAt: completedAt,
      }).where(and(eq(integrationOutbox.id, job.id), eq(integrationOutbox.status, "processing")));
      result.succeeded += 1;
    } catch (error) {
      const failedAt = new Date();
      await db.update(integrationOutbox).set({
        status: "failed",
        payload: shouldRotateRemoteKey(error) ? { ...job.payload, shopifyIdempotencyKey: randomUUID() } : job.payload,
        lockedAt: null,
        nextAttemptAt: retryAt(job.attempts, failedAt),
        lastError: errorMessage(error),
        updatedAt: failedAt,
      }).where(and(eq(integrationOutbox.id, job.id), eq(integrationOutbox.status, "processing")));
      result.failed += 1;
    }
  }

  return result;
}

async function transactionShopifySyncStatus(transactionId: string): Promise<ShopifySyncStatus> {
  const db = getDatabase();
  const rows = await db.select({ status: integrationOutbox.status }).from(integrationOutbox)
    .where(eq(integrationOutbox.transactionId, transactionId));
  if (!rows.length) return "not_required";
  if (rows.every((row) => row.status === "succeeded")) return "succeeded";
  if (rows.some((row) => row.status === "cancelled")) return "failed";
  return "pending";
}

export async function attemptAutomaticShopifySync(transactionId: string, currentStatus: ShopifySyncStatus): Promise<ShopifySyncStatus> {
  if (currentStatus === "not_required" || currentStatus === "succeeded") return currentStatus;
  try {
    await processShopifyOutbox({ force: true, limit: 10, transactionId });
    return await transactionShopifySyncStatus(transactionId);
  } catch (error) {
    console.error("Automatic Shopify inventory synchronization failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      transactionId,
    });
    return "pending";
  }
}
