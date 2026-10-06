import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { auditEvents, products, shopifyMappings } from "@/db/schema";
import { shopifyGraphQL } from "@/lib/shopify/client";
import { INVENTORY_ACTIVATE_MUTATION, PRODUCT_CREATE_MUTATION, PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, VARIANT_BY_SKU_QUERY } from "@/lib/shopify/queries";

export class ShopifyProductError extends Error {
  constructor(readonly code: "NOT_FOUND" | "ALREADY_ON_SHOPIFY" | "PRICE_REQUIRED" | "NO_LOCATION" | "SKU_CONFLICT", message: string) { super(message); }
}

type Level = { id: string; location: { id: string; name: string } };
interface VariantBySkuResponse { productVariants: { nodes: { id: string; sku: string | null; product: { id: string }; inventoryItem: { id: string; inventoryLevels: { nodes: Level[] } } }[] } }
interface ProductCreateResponse { productCreate: { product: { id: string; variants: { nodes: { id: string; inventoryItem: { id: string } }[] } } | null } }
interface InventoryActivateResponse { inventoryActivate: { inventoryLevel: Level | null } }

/** The Shopify location the store already stocks from (the one most existing mappings use). */
async function stockLocation() {
  const [row] = await getDatabase().select({ id: shopifyMappings.shopifyLocationId, name: shopifyMappings.shopifyLocationName, uses: sql<number>`count(*)` })
    .from(shopifyMappings).groupBy(shopifyMappings.shopifyLocationId, shopifyMappings.shopifyLocationName).orderBy(sql`count(*) desc`).limit(1);
  if (!row) throw new ShopifyProductError("NO_LOCATION", "No Shopify stock location is known yet. Run the Shopify catalog sync in Settings first.");
  return row;
}

/**
 * Lists a catalog product on Shopify (or links the existing Shopify variant with the same SKU) and records
 * the mapping, so future stock receipts send its Shopify share online. New Shopify products are ACTIVE but
 * not published to any sales channel; add images and make them available in Shopify admin to start selling.
 */
export async function addProductToShopify(productId: string, actorUsername: string) {
  const db = getDatabase();
  const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (!product) throw new ShopifyProductError("NOT_FOUND", "Product not found.");
  const existing = await db.select({ id: shopifyMappings.id }).from(shopifyMappings).where(eq(shopifyMappings.productId, productId)).limit(1);
  if (existing.length) throw new ShopifyProductError("ALREADY_ON_SHOPIFY", `${product.name} is already linked to Shopify.`);
  const location = await stockLocation();

  // Reuse a Shopify variant that already has this SKU, so retries never create duplicate listings.
  const found = await shopifyGraphQL<VariantBySkuResponse>(VARIANT_BY_SKU_QUERY, { query: `sku:"${product.sku.replace(/["\\]/g, "")}"` });
  const matches = found.productVariants.nodes.filter((variant) => variant.sku?.trim().toUpperCase() === product.sku);
  if (matches.length > 1) throw new ShopifyProductError("SKU_CONFLICT", `More than one Shopify variant uses SKU ${product.sku}. Fix the duplicate in Shopify first.`);

  let shopifyProductId: string, variantId: string, inventoryItemId: string, created = false;
  let level = matches[0]?.inventoryItem.inventoryLevels.nodes.find((item) => item.location.id === location.id) ?? null;
  if (matches[0]) {
    ({ id: variantId } = matches[0]);
    shopifyProductId = matches[0].product.id;
    inventoryItemId = matches[0].inventoryItem.id;
  } else {
    if (product.unitPricePaisa <= 0) throw new ShopifyProductError("PRICE_REQUIRED", `Set a price for ${product.name} before adding it to Shopify.`);
    const response = await shopifyGraphQL<ProductCreateResponse>(PRODUCT_CREATE_MUTATION, { product: { title: product.name, status: "ACTIVE" } });
    const variant = response.productCreate.product?.variants.nodes[0];
    if (!response.productCreate.product || !variant) throw new Error("Shopify did not return the new product.");
    shopifyProductId = response.productCreate.product.id;
    variantId = variant.id;
    inventoryItemId = variant.inventoryItem.id;
    created = true;
    await shopifyGraphQL(PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, {
      productId: shopifyProductId,
      variants: [{ id: variantId, price: (product.unitPricePaisa / 100).toFixed(2), inventoryItem: { sku: product.sku, tracked: true } }],
    });
  }
  if (!level) {
    const activated = await shopifyGraphQL<InventoryActivateResponse>(INVENTORY_ACTIVATE_MUTATION, { inventoryItemId, locationId: location.id });
    level = activated.inventoryActivate.inventoryLevel;
    if (!level) throw new Error("Shopify did not stock the product at the store location.");
  }

  const now = new Date();
  const [mapping] = await db.transaction(async (tx) => {
    const rows = await tx.insert(shopifyMappings).values({
      productId, shopifyProductId, shopifyVariantId: variantId, shopifyInventoryItemId: inventoryItemId,
      shopifyInventoryLevelId: level.id, shopifyLocationId: level.location.id, shopifyLocationName: level.location.name,
      status: "mapped", lastVerifiedAt: now,
    }).onConflictDoUpdate({
      target: [shopifyMappings.shopifyInventoryItemId, shopifyMappings.shopifyLocationId],
      set: { productId, shopifyProductId, shopifyVariantId: variantId, shopifyInventoryLevelId: level.id, status: "mapped", lastVerifiedAt: now, updatedAt: now },
    }).returning({ id: shopifyMappings.id });
    await tx.insert(auditEvents).values({
      actorUsername, action: created ? "product.shopify_created" : "product.shopify_linked", entityType: "product", entityId: productId,
      newValue: { sku: product.sku, shopifyProductId, shopifyVariantId: variantId, shopifyLocationId: level.location.id },
      reason: created ? "Product listed on Shopify from the command center" : "Existing Shopify variant linked by SKU",
    });
    return rows;
  });
  return { mappingId: mapping.id, created, shopifyProductId };
}
