import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { ShopifyAuthenticationError, ShopifyGraphQLError, ShopifyUserError } from "@/lib/shopify/errors";
import { addProductToShopify, ShopifyProductError } from "@/services/shopify-products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRODUCT_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff", "retail_sales"] as const;

export async function POST(_request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, PRODUCT_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot add products to Shopify." } }, { status: 403 });
  const { productId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(productId)) return Response.json({ error: { code: "NOT_FOUND", message: "Product not found." } }, { status: 404 });

  try {
    const result = await addProductToShopify(productId, session.username);
    return Response.json({ ok: true, ...result }, { status: result.created ? 201 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ShopifyProductError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 409 });
    if (error instanceof ShopifyAuthenticationError) return Response.json({ error: { code: "SHOPIFY_AUTH", message: "Shopify rejected the app credentials. Check the Shopify app installation." } }, { status: 502 });
    if (error instanceof ShopifyUserError || error instanceof ShopifyGraphQLError) {
      const missingScope = /access denied|required access/i.test(error.message);
      return Response.json({ error: { code: "SHOPIFY_REJECTED", message: missingScope ? "The Shopify app needs the write_products and write_inventory permissions to create products. Update the app's access scopes in Shopify and reinstall it." : `Shopify: ${error.message}` } }, { status: 502 });
    }
    console.error("Adding product to Shopify failed", error);
    return Response.json({ error: { code: "SHOPIFY_FAILED", message: "The product could not be added to Shopify. Try again." } }, { status: 502 });
  }
}
