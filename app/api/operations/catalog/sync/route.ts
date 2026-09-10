import { getDashboardSession } from "@/lib/auth/authorization";
import { syncShopifyCatalog } from "@/services/catalog-sync";
import { processShopifyOutbox } from "@/services/shopify-outbox";
import { ensureShopifyWebhookSubscriptions } from "@/services/shopify-webhook-subscriptions";
import { isManagementRole } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: { code: "FORBIDDEN", message: "Management access is required." } }, { status: 403 });
  try {
    const result = await syncShopifyCatalog();
    const inventoryUpdates = await processShopifyOutbox({ force: true, limit: 50 });
    const webhooks = await ensureShopifyWebhookSubscriptions(request.url);
    return Response.json({ ok: true, result, inventoryUpdates, webhooks }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: { code: "CATALOG_SYNC_FAILED", message: error instanceof Error ? error.message : "Shopify catalog sync failed." } }, { status: 500 });
  }
}
