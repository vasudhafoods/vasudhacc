import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { fulfillShopifyWarehouseOrder } from "@/services/shopify-fulfillment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { message: "This account cannot fulfill Shopify orders." } }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const result = await fulfillShopifyWarehouseOrder({
      orderId: String(body.orderId ?? ""),
      trackingNumber: String(body.trackingNumber ?? ""),
      carrier: String(body.carrier ?? ""),
      trackingUrl: typeof body.trackingUrl === "string" ? body.trackingUrl : undefined,
      notifyCustomer: body.notifyCustomer !== false,
    });
    return Response.json({ ok: true, result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: { message: error instanceof Error ? error.message : "Shopify fulfillment could not be created." } }, { status: 400 });
  }
}
