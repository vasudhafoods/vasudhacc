import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { InventoryCommandError, receiveAndAllocateStock } from "@/services/inventory-ledger";
import { attemptAutomaticShopifySync } from "@/services/shopify-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

function optionalDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new InventoryCommandError("INVALID_RECEIPT", "Manufacturing and expiry dates must be valid dates.");
  return date;
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot enter warehouse stock." } }, { status: 403 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const result = await receiveAndAllocateStock({
      productId: String(body.productId ?? ""),
      warehouseLocationId: String(body.warehouseLocationId ?? ""),
      receivedQuantity: Number(body.receivedQuantity),
      damagedQuantity: Number(body.damagedQuantity ?? 0),
      onlineQuantity: Number(body.onlineQuantity ?? 0),
      retailQuantity: Number(body.retailQuantity ?? 0),
      bufferQuantity: Number(body.bufferQuantity ?? 0),
      batchNumber: String(body.batchNumber ?? ""),
      manufacturingDate: optionalDate(body.manufacturingDate),
      expiryDate: optionalDate(body.expiryDate),
      actorUsername: session.username,
      reason: "Warehouse stock received and allocated",
      source: String(body.source ?? "Warehouse stock entry").trim(),
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      shopifyMappingId: body.shopifyMappingId ? String(body.shopifyMappingId) : undefined,
      referenceId: body.referenceId ? String(body.referenceId) : undefined,
    });
    const shopifySync = await attemptAutomaticShopifySync(result.transactionId, result.shopifySync);
    return Response.json({ ok: true, result: { ...result, shopifySync } }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    }
    return Response.json({ error: { code: "RECEIPT_FAILED", message: error instanceof Error ? error.message : "Stock receipt failed." } }, { status: 500 });
  }
}
