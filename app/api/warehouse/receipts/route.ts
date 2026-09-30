import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { InventoryCommandError, receiveAndAllocateStock } from "@/services/inventory-ledger";
import { attemptAutomaticShopifySync } from "@/services/shopify-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

function optionalDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const raw = String(value);
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00+05:30` : raw);
  if (Number.isNaN(date.getTime())) throw new InventoryCommandError("INVALID_RECEIPT", "Manufacturing and expiry dates must be valid dates.");
  return date;
}

function receiptDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = new Date(`${String(value)}T12:00:00+05:30`);
  if (Number.isNaN(date.getTime())) throw new InventoryCommandError("INVALID_RECEIPT", "Receiving date must be a valid date.");
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
      supplierName: body.supplierName ? String(body.supplierName).trim() : undefined,
      invoiceValuePaisa: body.invoiceValue === undefined || body.invoiceValue === "" ? undefined : Math.round(Number(body.invoiceValue) * 100),
      receivedAt: receiptDate(body.receiptDate),
      referenceId: body.referenceId ? String(body.referenceId) : undefined,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      shopifyMappingId: body.shopifyMappingId ? String(body.shopifyMappingId) : undefined,
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
