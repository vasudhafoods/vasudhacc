import { getDashboardSession } from "@/lib/auth/authorization";
import { syncShopifyCatalog } from "@/services/catalog-sync";
import { isManagementRole } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: { code: "FORBIDDEN", message: "Management access is required." } }, { status: 403 });
  try {
    return Response.json({ ok: true, result: await syncShopifyCatalog() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: { code: "CATALOG_SYNC_FAILED", message: error instanceof Error ? error.message : "Shopify catalog sync failed." } }, { status: 500 });
  }
}
