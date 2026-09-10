import { inventoryBucket, type InventoryBucket } from "@/db/schema";
import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { disposeInventory, InventoryCommandError } from "@/services/inventory-ledger";
import { attemptAutomaticShopifySync } from "@/services/shopify-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;
const DISPOSAL_REASONS = ["expired", "damaged", "contaminated", "quality_rejected", "other"] as const;

function isBucket(value: unknown): value is InventoryBucket {
  return typeof value === "string" && inventoryBucket.enumValues.includes(value as InventoryBucket);
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot dispose stock." } }, { status: 403 });

  try {
    const body = await request.json() as Record<string, unknown>;
    if (!isBucket(body.sourceBucket)) return Response.json({ error: { code: "INVALID_DISPOSAL", message: "Select the stock bucket holding these packets." } }, { status: 400 });
    const disposalReason = DISPOSAL_REASONS.find((reason) => reason === body.disposalReason);
    if (!disposalReason) return Response.json({ error: { code: "INVALID_DISPOSAL", message: "Select a valid disposal reason." } }, { status: 400 });
    const result = await disposeInventory({
      productId: String(body.productId ?? ""),
      warehouseLocationId: String(body.warehouseLocationId ?? ""),
      sourceBucket: body.sourceBucket,
      quantity: Number(body.quantity),
      disposalReason,
      referenceId: String(body.referenceId ?? ""),
      notes: body.notes ? String(body.notes) : undefined,
      actorUsername: session.username,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      shopifyMappingId: body.shopifyMappingId ? String(body.shopifyMappingId) : undefined,
    });
    const shopifySync = await attemptAutomaticShopifySync(result.transactionId, result.shopifySync);
    return Response.json({ ok: true, result: { ...result, shopifySync } }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) {
      const status = error.code === "INSUFFICIENT_STOCK" ? 409 : error.code === "NOT_FOUND" ? 404 : 400;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return Response.json({ error: { code: "DISPOSAL_FAILED", message: error instanceof Error ? error.message : "Stock disposal could not be recorded." } }, { status: 500 });
  }
}
