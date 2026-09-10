import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { dispatchRetailStock, InventoryCommandError } from "@/services/inventory-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot dispatch retail stock." } }, { status: 403 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    const lines = rawLines.map((value) => {
      const line = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { productId: String(line.productId ?? ""), quantity: Number(line.quantity) };
    });
    const result = await dispatchRetailStock({
      warehouseLocationId: String(body.warehouseLocationId ?? ""),
      lines,
      destination: String(body.destination ?? ""),
      referenceId: String(body.referenceId ?? ""),
      notes: body.notes ? String(body.notes) : undefined,
      actorUsername: session.username,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
    });
    return Response.json({ ok: true, result }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) {
      const status = error.code === "INSUFFICIENT_STOCK" ? 409 : error.code === "NOT_FOUND" ? 404 : 400;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return Response.json({ error: { code: "RETAIL_DISPATCH_FAILED", message: error instanceof Error ? error.message : "Retail dispatch could not be saved." } }, { status: 500 });
  }
}
