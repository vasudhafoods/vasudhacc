import "server-only";
import { shopifyGraphQL } from "@/lib/shopify/client";
import {
  WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
  WEBHOOK_SUBSCRIPTIONS_QUERY,
} from "@/lib/shopify/queries";

const WEBHOOK_PATH = "/api/shopify/webhooks";
const REQUIRED_TOPICS = ["FULFILLMENTS_CREATE", "REFUNDS_CREATE"] as const;

interface WebhookSubscription {
  id: string;
  topic: string;
  uri: string;
}

interface WebhookSubscriptionsResponse {
  webhookSubscriptions: { nodes: WebhookSubscription[] };
}

interface WebhookSubscriptionCreateResponse {
  webhookSubscriptionCreate: {
    webhookSubscription: WebhookSubscription | null;
    userErrors: { field?: string[]; message: string }[];
  };
}

export interface ShopifyWebhookSubscriptionResult {
  callbackUrl: string;
  created: string[];
  existing: string[];
}

function productionBaseUrl(requestUrl: string): string {
  const configured = process.env.APP_BASE_URL?.trim();
  const vercelProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const candidate = configured || (vercelProductionUrl ? `https://${vercelProductionUrl}` : new URL(requestUrl).origin);
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("APP_BASE_URL must use HTTPS for Shopify webhooks.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function ensureShopifyWebhookSubscriptions(requestUrl: string): Promise<ShopifyWebhookSubscriptionResult> {
  const callbackUrl = `${productionBaseUrl(requestUrl)}${WEBHOOK_PATH}`;
  const subscriptions = await shopifyGraphQL<WebhookSubscriptionsResponse>(WEBHOOK_SUBSCRIPTIONS_QUERY, { first: 250 });
  const result: ShopifyWebhookSubscriptionResult = { callbackUrl, created: [], existing: [] };

  for (const topic of REQUIRED_TOPICS) {
    const alreadyExists = subscriptions.webhookSubscriptions.nodes.some(
      (subscription) => subscription.topic === topic && subscription.uri === callbackUrl,
    );
    if (alreadyExists) {
      result.existing.push(topic);
      continue;
    }

    const response = await shopifyGraphQL<WebhookSubscriptionCreateResponse>(WEBHOOK_SUBSCRIPTION_CREATE_MUTATION, {
      topic,
      webhookSubscription: { uri: callbackUrl },
    });
    if (!response.webhookSubscriptionCreate.webhookSubscription) {
      throw new Error(`Shopify did not confirm the ${topic} webhook subscription.`);
    }
    result.created.push(topic);
  }

  return result;
}
