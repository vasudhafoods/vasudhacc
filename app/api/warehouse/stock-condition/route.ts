import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { isConditionTransfer } from "@/lib/inventory/stock-condition";
import { InventoryCommandError, transferInventory } from "@/services/inventory-ledger";
import { attemptStockMovementShopifySync } from "@/services/shopify-outbox";
import type { InventoryBucket } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, ["admin", "management", "warehouse_manager", "warehouse_staff"])) return Response.json({ error: { message: "Warehouse access is required." } }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!isConditionTransfer(body.fromBucket, body.toBucket)) return Response.json({ error: { message: "Move stock into Damaged or QC / Hold, or release inspected QC stock to Buffer." } }, { status: 400 });
    const reason = String(body.reason ?? "").trim();
    if (!reason || reason.length > 1000) return Response.json({ error: { message: "Enter a reason of 1–1000 characters." } }, { status: 400 });
    const result = await transferInventory({
      productId: String(body.productId ?? ""), warehouseLocationId: String(body.warehouseLocationId ?? ""),
      fromBucket: body.fromBucket as InventoryBucket, toBucket: body.toBucket as InventoryBucket,
      quantity: Number(body.quantity), actorUsername: session.username, reason,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      shopifyMappingId: body.shopifyMappingId ? String(body.shopifyMappingId) : undefined,
    });
    const shopifySync = await attemptStockMovementShopifySync(result.stockRotationTransactionId ?? result.transactionId, result.transactionId, result.shopifySync);
    return Response.json({ ok: true, result: { ...result, shopifySync } }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) return Response.json({ error: { message: error.message } }, { status: error.code === "INSUFFICIENT_STOCK" ? 409 : error.code === "NOT_FOUND" ? 404 : 400 });
    if (error instanceof SyntaxError) return Response.json({ error: { message: "Invalid stock movement data." } }, { status: 400 });
    return Response.json({ error: { message: "Stock movement could not be confirmed. Retry the same entry." } }, { status: 500 });
  }
}
