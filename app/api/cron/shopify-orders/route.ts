import { maintainShopifyAutomation, readShopifyAutomationStatus } from "@/services/shopify-automation";
import { EnvironmentConfigurationError, isAuthorizedInternalRequest } from "@/lib/validation/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

// Lightweight order sync for an external every-minute scheduler; the daily snapshot cron stays separate.
export async function GET(request: Request) {
  try {
    if (!isAuthorizedInternalRequest(request)) return json({ error: { code: "UNAUTHORIZED", message: "A valid bearer token is required." } }, 401);
    const run = await maintainShopifyAutomation(request.url);
    const status = await readShopifyAutomationStatus();
    return json({ ok: !status.error, run, checkedThrough: status.checkedThrough, failedEvents: status.failed, error: status.error });
  } catch (error: unknown) {
    if (error instanceof EnvironmentConfigurationError) return json({ error: { code: error.code, message: error.message } }, 503);
    console.error("Shopify order sync failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return json({ error: { code: "INTERNAL_ERROR", message: "Shopify order sync failed; the next run will retry." } }, 500);
  }
}
