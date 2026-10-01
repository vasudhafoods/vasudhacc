import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { OfflineSalesError, updateOfflineSaleDeliveryStatus } from "@/services/offline-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

export async function PATCH(request: Request, { params }: { params: Promise<{ saleId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { message: "This account cannot update warehouse orders." } }, { status: 403 });
  try {
    const body = await request.json() as { status?: unknown; deliveryPartner?: unknown; trackingNumber?: unknown; trackingUrl?: unknown };
    const status = String(body.status ?? "");
    if (!["packing", "shipped", "out_for_delivery", "dispatched", "delivered", "cancelled"].includes(status)) return Response.json({ error: { message: "Choose a valid warehouse status." } }, { status: 400 });
    const { saleId } = await params;
    const result = await updateOfflineSaleDeliveryStatus({ saleId, status: status as "packing" | "shipped" | "out_for_delivery" | "dispatched" | "delivered" | "cancelled", deliveryPartner: typeof body.deliveryPartner === "string" ? body.deliveryPartner : undefined, trackingNumber: typeof body.trackingNumber === "string" ? body.trackingNumber : undefined, trackingUrl: typeof body.trackingUrl === "string" ? body.trackingUrl : undefined, actorUsername: session.username });
    return Response.json({ ok: true, result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OfflineSalesError) return Response.json({ error: { message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    return Response.json({ error: { message: error instanceof Error ? error.message : "Warehouse order could not be updated." } }, { status: 500 });
  }
}
