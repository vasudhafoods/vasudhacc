import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { createWarehouseProduct, WarehouseProductError } from "@/services/warehouse-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot create warehouse products." } }, { status: 403 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const product = await createWarehouseProduct({
      sku: String(body.sku ?? ""),
      name: String(body.name ?? ""),
      packSize: body.packSize ? String(body.packSize) : undefined,
      barcode: body.barcode ? String(body.barcode) : undefined,
    }, session.username);
    return Response.json({ ok: true, product }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof WarehouseProductError) {
      const status = error.code === "SKU_EXISTS" || error.code === "BARCODE_EXISTS" ? 409 : 400;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return Response.json({ error: { code: "PRODUCT_CREATE_FAILED", message: error instanceof Error ? error.message : "Product creation failed." } }, { status: 500 });
  }
}
