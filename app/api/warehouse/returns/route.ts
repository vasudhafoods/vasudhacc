import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { InventoryCommandError, receiveReturnedStock } from "@/services/inventory-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot receive returned stock." } }, { status: 403 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const orderType = body.orderType === "shopify" ? "shopify" : "retail";
    const toDate = (value: unknown) => {
      if (!value) return undefined;
      const raw = String(value);
      const parsed = new Date(`${raw}T12:00:00+05:30`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(parsed.getTime())) throw new InventoryCommandError("INVALID_RETURN", "Return dates must be valid dates.");
      return parsed;
    };
    const result = await receiveReturnedStock({
      productId: String(body.productId ?? ""),
      warehouseLocationId: String(body.warehouseLocationId ?? ""),
      quantity: Number(body.quantity),
      channel: orderType,
      orderType,
      referenceId: String(body.referenceId ?? ""),
      reason: String(body.reason ?? ""),
      courier: body.courier ? String(body.courier) : undefined,
      rtoCostPaisa: body.rtoCostPaisa === undefined || body.rtoCostPaisa === "" ? undefined : Number(body.rtoCostPaisa),
      manifestedAt: toDate(body.manifestedAt),
      receivedAt: toDate(body.receivedAt),
      condition: body.condition === "damaged" || body.condition === "missing" || body.condition === "expired" ? body.condition : "usable",
      notes: body.notes ? String(body.notes) : undefined,
      actorUsername: session.username,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
    });
    return Response.json({ ok: true, result }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "INSUFFICIENT_STOCK" ? 409 : 400;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return Response.json({ error: { code: "RETURN_RECEIPT_FAILED", message: error instanceof Error ? error.message : "Returned stock could not be received." } }, { status: 500 });
  }
}
