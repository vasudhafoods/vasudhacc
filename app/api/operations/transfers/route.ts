import { getDashboardSession } from "@/lib/auth/authorization";
import { inventoryBucket, type InventoryBucket } from "@/db/schema";
import { InventoryCommandError, transferInventory } from "@/services/inventory-ledger";
import { isManagementRole } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isBucket(value: unknown): value is InventoryBucket {
  return typeof value === "string" && inventoryBucket.enumValues.includes(value as InventoryBucket);
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: { code: "FORBIDDEN", message: "Management access is required." } }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!isBucket(body.fromBucket) || !isBucket(body.toBucket)) {
      return Response.json({ error: { code: "INVALID_TRANSFER", message: "Valid source and destination buckets are required." } }, { status: 400 });
    }
    const result = await transferInventory({
      productId: String(body.productId ?? ""),
      warehouseLocationId: String(body.warehouseLocationId ?? ""),
      fromBucket: body.fromBucket,
      toBucket: body.toBucket,
      quantity: Number(body.quantity),
      actorUsername: session.username,
      reason: String(body.reason ?? "").trim(),
      idempotencyKey,
      shopifyMappingId: body.shopifyMappingId ? String(body.shopifyMappingId) : undefined,
      referenceId: body.referenceId ? String(body.referenceId) : undefined,
    });
    return Response.json({ ok: true, result }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) {
      const status = error.code === "INSUFFICIENT_STOCK" ? 409 : error.code === "NOT_FOUND" ? 404 : 400;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return Response.json({ error: { code: "TRANSFER_FAILED", message: error instanceof Error ? error.message : "Inventory transfer failed." } }, { status: 500 });
  }
}
