import { getDashboardSession } from "@/lib/auth/authorization";
import { isManagementRole } from "@/types/auth";
import { ProductBundleError, readBundleSetup, saveBundleRecipe } from "@/services/product-bundles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: { code: "FORBIDDEN", message: "Management access is required." } }, { status: 403 });
  try {
    const body = await request.json() as { bundleProductId?: unknown; components?: unknown };
    const components = Array.isArray(body.components) ? body.components.map((row) => {
      const value = row && typeof row === "object" ? row as Record<string, unknown> : {};
      return { productId: String(value.productId ?? ""), quantity: Number(value.quantity) };
    }) : [];
    await saveBundleRecipe(String(body.bundleProductId ?? ""), components, session.username);
    return Response.json({ ok: true, ...await readBundleSetup() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ProductBundleError) return Response.json({ error: { code: "INVALID_BUNDLE", message: error.message } }, { status: 400 });
    console.error("Combo contents could not be saved", { name: error instanceof Error ? error.name : "UnknownError" });
    return Response.json({ error: { code: "BUNDLE_SAVE_FAILED", message: "Combo contents could not be saved." } }, { status: 500 });
  }
}
