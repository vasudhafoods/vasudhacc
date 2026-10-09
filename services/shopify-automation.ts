import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { shopifySyncState, shopifyWebhookEvents } from "@/db/schema";
import { shopifyGraphQL } from "@/lib/shopify/client";
import { ORDER_RECOVERY_QUERY, recoveryPayloads, type RecoveryOrder } from "@/lib/shopify/order-recovery";
import { ensureShopifyWebhookSubscriptions } from "./shopify-webhook-subscriptions";
import { isQueuedForRetry, processShopifyWebhook, retryShopifyWebhookEvents, shopifyPayloadHash, type ShopifyWebhookTopic } from "./shopify-webhooks";
import { processShopifyOutbox } from "./shopify-outbox";

const KEY = "orders";
export async function readShopifyAutomationStatus() {
  try {
    const db = getDatabase();
    const [state] = await db.select().from(shopifySyncState).where(eq(shopifySyncState.key, KEY));
    const [events] = await db.select({ lastEventAt: sql<string | null>`max(${shopifyWebhookEvents.processedAt}) filter (where ${shopifyWebhookEvents.status} = 'succeeded')`, failed: sql<number>`count(*) filter (where ${shopifyWebhookEvents.status} = 'failed')::int` }).from(shopifyWebhookEvents);
    return { enabledAt: state?.enabledAt ?? null, subscriptionsCheckedAt: state?.subscriptionsCheckedAt ?? null, lastSucceededAt: state?.lastSucceededAt ?? null, checkedThrough: state?.checkedThrough ?? null, error: state?.lastError ?? null, ...events };
  } catch (error) {
    console.error("Unable to read Shopify automation status", { name: error instanceof Error ? error.name : "UnknownError" });
    return { enabledAt: null, subscriptionsCheckedAt: null, lastSucceededAt: null, checkedThrough: null, lastEventAt: null, failed: 0, error: "Database migration required. Apply the latest database migrations to enable automatic Shopify sync." };
  }
}

export async function maintainShopifyAutomation(requestUrl?: string) {
  // Preview deployments must never register themselves as the production callback.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") return { skipped: true };
  const origin = process.env.APP_BASE_URL?.trim() || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : requestUrl);
  if (!origin) return { skipped: true };
  const db = getDatabase();
  await db.insert(shopifySyncState).values({ key: KEY }).onConflictDoNothing();
  const leaseUntil = new Date(Date.now() + 5 * 60_000);
  const [state] = await db.update(shopifySyncState).set({ lockedUntil: leaseUntil }).where(sql`${shopifySyncState.key} = ${KEY} and (${shopifySyncState.lockedUntil} is null or ${shopifySyncState.lockedUntil} < now())`).returning();
  if (!state) return { skipped: true };
  const errors: string[] = [];
  try {
    if (!state.subscriptionsCheckedAt || Date.now() - state.subscriptionsCheckedAt.getTime() > 60 * 60_000) {
      try {
        await ensureShopifyWebhookSubscriptions(origin);
        await db.update(shopifySyncState).set({ subscriptionsCheckedAt: new Date() }).where(eq(shopifySyncState.key, KEY));
      } catch (error) { errors.push(error instanceof Error ? error.message : "Webhook registration failed."); }
    }
    const retried = await retryShopifyWebhookEvents(10);
    if (retried.failed) errors.push(`${retried.failed} inventory events still need retry; see failed Shopify events.`);
    // Use a persisted window and cursor. Never replay stock history predating activation.
    const until = state.scanUntil ?? new Date();
    const from = new Date(Math.max(state.enabledAt.getTime(), (state.checkedThrough ?? state.enabledAt).getTime() - 60_000));
    try {
      const result = await shopifyGraphQL<{ orders: { nodes: RecoveryOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(ORDER_RECOVERY_QUERY, { after: state.cursor, query: `created_at:>=${state.enabledAt.toISOString()} updated_at:>=${from.toISOString()} updated_at:<=${until.toISOString()}` });
      for (const order of result.orders.nodes) {
        if (order.test || new Date(order.createdAt) < state.enabledAt) continue;
        const payloads = recoveryPayloads(order);
        const apply = async (topic: ShopifyWebhookTopic, payload: unknown) => {
          const hash = shopifyPayloadHash(Buffer.from(JSON.stringify(payload)));
          const eventId = `recovery:${topic}:${order.id}:${hash}`;
          try {
            await processShopifyWebhook({ eventId, topic, payloadHash: hash, payload });
          } catch (error) {
            const message = `Order ${order.name}: ${error instanceof Error ? error.message : "Recovery failed"}`;
            // A failed event saved with its payload is retried separately, so one bad order cannot stall the scan.
            if (!await isQueuedForRetry(eventId)) throw new Error(message);
            errors.push(message);
          }
        };
        await apply(order.cancelledAt ? "orders/cancelled" : "orders/create", payloads.order);
        if (!order.cancelledAt) for (const refund of payloads.refunds) await apply("refunds/create", refund);
      }
      const next = result.orders.pageInfo;
      await db.update(shopifySyncState).set(next.hasNextPage
        ? { cursor: next.endCursor, scanUntil: until }
        : { cursor: null, scanUntil: null, checkedThrough: until }).where(eq(shopifySyncState.key, KEY));
    } catch (error) { errors.push(error instanceof Error ? error.message : "Order recovery failed."); }
    const writes = await processShopifyOutbox({ limit: 10 });
    if (writes.failed) errors.push(`${writes.failed} Shopify inventory writes are waiting for retry.`);
    await db.update(shopifySyncState).set({ lastError: errors.length ? errors.join(" ").slice(0, 2000) : null, ...(errors.length ? {} : { lastSucceededAt: new Date() }) }).where(eq(shopifySyncState.key, KEY));
    return { skipped: false, errors };
  } catch (error) {
    await db.update(shopifySyncState).set({ lastError: error instanceof Error ? error.message.slice(0, 2000) : "Automatic synchronization failed; retry pending." }).where(eq(shopifySyncState.key, KEY));
    throw error;
  } finally {
    await db.update(shopifySyncState).set({ lockedUntil: new Date(Date.now() + 60_000) }).where(sql`${shopifySyncState.key} = ${KEY} and ${shopifySyncState.lockedUntil} = ${leaseUntil.toISOString()}::timestamptz`);
  }
}
