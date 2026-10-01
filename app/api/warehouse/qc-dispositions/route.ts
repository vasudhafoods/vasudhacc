import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { InventoryCommandError, transferInventory } from "@/services/inventory-ledger";
import { attemptAutomaticShopifySync } from "@/services/shopify-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;
const TARGET_BUCKETS = ["online", "retail", "buffer", "damaged"] as const;

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot review QC stock." } }, { status: 403 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const toBucket = TARGET_BUCKETS.find((bucket) => bucket === body.toBucket);
    if (!toBucket) return Response.json({ error: { code: "INVALID_TRANSFER", message: "Select Online, Retail, Buffer, or Damaged as the QC decision." } }, { status: 400 });
    const result = await transferInventory({
      productId: String(body.productId ?? ""),
      warehouseLocationId: String(body.warehouseLocationId ?? ""),
      fromBucket: "qc",
      toBucket,
      quantity: Number(body.quantity),
      actorUsername: session.username,
      reason: String(body.reason ?? "QC inspection completed").trim(),
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      shopifyMappingId: body.shopifyMappingId ? String(body.shopifyMappingId) : undefined,
      referenceId: body.referenceId ? String(body.referenceId) : undefined,
    });
    const shopifySync = await attemptAutomaticShopifySync(result.transactionId, result.shopifySync);
    return Response.json({ ok: true, result: { ...result, shopifySync } }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) {
      const status = error.code === "INSUFFICIENT_STOCK" ? 409 : error.code === "NOT_FOUND" ? 404 : 400;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return Response.json({ error: { code: "QC_DISPOSITION_FAILED", message: error instanceof Error ? error.message : "QC stock could not be updated." } }, { status: 500 });
  }
}
