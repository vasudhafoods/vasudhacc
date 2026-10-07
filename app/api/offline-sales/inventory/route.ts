import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventoryBalances, products, warehouseLocations } from "@/db/schema";
import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { isPhysicalUnitProduct, physicalUnitDisplayName } from "@/lib/inventory/physical-units";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (!sessionHasRole(session, ["admin", "management", "retail_sales"])) return Response.json({ error: "Sales access required." }, { status: 403 });
  try {
    const db = getDatabase();
    const [catalog, locations, balances] = await Promise.all([
      db.select({ id: products.id, name: products.name, sku: products.sku }).from(products).where(eq(products.active, true)).orderBy(products.name),
      db.select({ id: warehouseLocations.id, name: warehouseLocations.name }).from(warehouseLocations).where(eq(warehouseLocations.active, true)).orderBy(warehouseLocations.name),
      db.select({ productId: inventoryBalances.productId, warehouseLocationId: inventoryBalances.warehouseLocationId, bucket: inventoryBalances.bucket, onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved }).from(inventoryBalances),
    ]);
    return Response.json({ products: catalog.filter(product => isPhysicalUnitProduct(product.name)).map(product => ({ ...product, name: physicalUnitDisplayName(product.name) })), locations, balances, refreshedAt: new Date().toISOString() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Inventory could not be loaded. Please retry." }, { status: 503 });
  }
}
