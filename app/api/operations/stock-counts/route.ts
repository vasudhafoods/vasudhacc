import { getDashboardSession } from "@/lib/auth/authorization";
import { PhysicalStockCountError, applyPhysicalStockCount } from "@/services/stock-counts";
import { attemptAutomaticShopifySync } from "@/services/shopify-outbox";
import { isManagementRole } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: { code: "FORBIDDEN", message: "Management access is required." } }, { status: 403 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const result = await applyPhysicalStockCount({
      lines: rawLines.map((entry) => {
        const line = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        return {
          productId: typeof line.productId === "string" ? line.productId : "",
          warehouseLocationId: typeof line.warehouseLocationId === "string" ? line.warehouseLocationId : "",
          quantity: typeof line.quantity === "number" ? line.quantity : Number.NaN,
        };
      }),
      actorUsername: session.username,
      reason: typeof body.reason === "string" ? body.reason.trim() : "",
      idempotencyKey,
    });
    const shopifySync = result.transactionId
      ? await attemptAutomaticShopifySync(result.transactionId, "pending")
      : "not_required";
    const hasIssues = result.results.some((line) => line.issue);
    return Response.json({ ok: !hasIssues, result: { ...result, shopifySync } }, {
      status: !result.transactionId && hasIssues ? 409 : result.duplicate ? 200 : 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof PhysicalStockCountError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    }
    return Response.json({ error: { code: "STOCK_COUNT_FAILED", message: error instanceof Error ? error.message : "Physical stock count could not be applied." } }, { status: 500 });
  }
}
