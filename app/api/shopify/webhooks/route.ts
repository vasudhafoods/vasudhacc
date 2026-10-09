import { EnvironmentConfigurationError, getShopifyConfig } from "@/lib/validation/env";
import {
  processShopifyWebhook,
  SHOPIFY_WEBHOOK_TOPICS,
  shopifyPayloadHash,
  type ShopifyWebhookTopic,
  isQueuedForRetry,
  verifyShopifyWebhook,
} from "@/services/shopify-webhooks";
import { after } from "next/server";
import { attemptAutomaticShopifySync } from "@/services/shopify-outbox";
import { maintainShopifyAutomation } from "@/services/shopify-automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

function isSupportedTopic(topic: string): topic is ShopifyWebhookTopic {
  return (SHOPIFY_WEBHOOK_TOPICS as readonly string[]).includes(topic);
}

export async function POST(request: Request) {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Webhook payload is too large." } }, 413);
    }
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (rawBody.length > MAX_BODY_BYTES) return json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Webhook payload is too large." } }, 413);
    if (!verifyShopifyWebhook(rawBody, request.headers.get("x-shopify-hmac-sha256"))) {
      return json({ error: { code: "INVALID_SIGNATURE", message: "Shopify webhook signature is invalid." } }, 401);
    }

    const expectedShop = getShopifyConfig().storeDomain;
    const deliveredShop = request.headers.get("x-shopify-shop-domain")?.trim().toLowerCase();
    if (deliveredShop !== expectedShop) return json({ error: { code: "WRONG_SHOP", message: "Webhook was sent for a different Shopify store." } }, 401);

    const topic = request.headers.get("x-shopify-topic")?.trim().toLowerCase() ?? "";
    if (!isSupportedTopic(topic)) return json({ error: { code: "UNSUPPORTED_TOPIC", message: "Webhook topic is not supported." } }, 400);
    const eventId = request.headers.get("x-shopify-event-id")?.trim() || request.headers.get("x-shopify-webhook-id")?.trim();
    if (!eventId) return json({ error: { code: "MISSING_EVENT_ID", message: "Shopify event id is missing." } }, 400);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return json({ error: { code: "INVALID_JSON", message: "Webhook payload is not valid JSON." } }, 400);
    }
    // Each delivery also runs the catch-up scan, so orders missed by any earlier delivery are applied.
    after(async () => {
      try { await maintainShopifyAutomation(request.url); }
      catch { console.error("Shopify catch-up scan after webhook failed; next trigger will retry."); }
    });
    let result;
    try {
      result = await processShopifyWebhook({ eventId, topic, payloadHash: shopifyPayloadHash(rawBody), payload });
    } catch (error) {
      // Acknowledge saved events so Shopify does not drop the subscription; the retry loop applies them.
      if (await isQueuedForRetry(eventId)) return json({ ok: false, queuedForRetry: true, message: error instanceof Error ? error.message : "Queued for retry." });
      throw error;
    }
    const shopifySync = result.transactionId && ["orders/create", "orders/cancelled", "refunds/create"].includes(topic)
      ? await attemptAutomaticShopifySync(result.transactionId, "pending")
      : "not_required";
    return json({ ok: true, ...result, shopifySync });
  } catch (error) {
    if (error instanceof EnvironmentConfigurationError) {
      return json({ error: { code: error.code, message: error.message } }, 503);
    }
    console.error("Shopify webhook processing failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return json({ error: { code: "WEBHOOK_PROCESSING_FAILED", message: error instanceof Error ? error.message : "Shopify webhook could not be processed." } }, 500);
  }
}
