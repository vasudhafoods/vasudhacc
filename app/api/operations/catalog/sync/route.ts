import { getDashboardSession } from "@/lib/auth/authorization";
import { syncShopifyCatalog } from "@/services/catalog-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (!await getDashboardSession()) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  try {
    return Response.json({ ok: true, result: await syncShopifyCatalog() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: { code: "CATALOG_SYNC_FAILED", message: error instanceof Error ? error.message : "Shopify catalog sync failed." } }, { status: 500 });
  }
}
