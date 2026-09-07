import "server-only";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { products, shopifyMappings } from "@/db/schema";
import { fetchCurrentInventory } from "@/services/shopify-inventory";

export interface CatalogSyncResult {
  capturedAt: string;
  inventoryRows: number;
  mappedRows: number;
  conflictedRows: number;
  skippedMissingSku: number;
  distinctSkus: number;
}

export async function syncShopifyCatalog(): Promise<CatalogSyncResult> {
  const inventory = await fetchCurrentInventory();
  const db = getDatabase();
  let mappedRows = 0;
  let conflictedRows = 0;
  let skippedMissingSku = 0;
  const skus = new Set<string>();
  const inventoryItemsBySku = new Map<string, Set<string>>();
  for (const item of inventory.items) {
    const sku = item.sku?.trim().toUpperCase();
    if (!sku) continue;
    const ids = inventoryItemsBySku.get(sku) ?? new Set<string>();
    ids.add(item.inventoryItemId);
    inventoryItemsBySku.set(sku, ids);
  }

  await db.transaction(async (tx) => {
    for (const item of inventory.items) {
      const sku = item.sku?.trim().toUpperCase();
      if (!sku) {
        skippedMissingSku += 1;
        continue;
      }
      skus.add(sku);
      const [product] = await tx.insert(products).values({
        sku,
        name: item.variantTitle === "Default Title" ? item.productTitle : `${item.productTitle} · ${item.variantTitle}`,
        active: item.productStatus === "ACTIVE",
      }).onConflictDoUpdate({
        target: products.sku,
        set: {
          name: item.variantTitle === "Default Title" ? item.productTitle : `${item.productTitle} · ${item.variantTitle}`,
          active: item.productStatus === "ACTIVE",
          updatedAt: new Date(),
        },
      }).returning({ id: products.id });

      const status = (inventoryItemsBySku.get(sku)?.size ?? 0) > 1 ? "conflict" : "mapped";
      await tx.insert(shopifyMappings).values({
        productId: product.id,
        shopifyProductId: item.productId,
        shopifyVariantId: item.variantId,
        shopifyInventoryItemId: item.inventoryItemId,
        shopifyInventoryLevelId: item.inventoryLevelId,
        shopifyLocationId: item.locationId,
        shopifyLocationName: item.locationName,
        status,
        lastVerifiedAt: new Date(inventory.capturedAt),
      }).onConflictDoUpdate({
        target: [shopifyMappings.shopifyInventoryItemId, shopifyMappings.shopifyLocationId],
        set: {
          productId: product.id,
          shopifyProductId: item.productId,
          shopifyVariantId: item.variantId,
          shopifyInventoryLevelId: item.inventoryLevelId,
          shopifyLocationName: item.locationName,
          status,
          lastVerifiedAt: new Date(inventory.capturedAt),
          updatedAt: new Date(),
        },
      });
      if (status === "mapped") mappedRows += 1;
      else conflictedRows += 1;
    }

    const activeMappings = await tx.select({ id: shopifyMappings.id }).from(shopifyMappings).where(eq(shopifyMappings.status, "mapped"));
    if (mappedRows > 0 && activeMappings.length === 0) throw new Error("Shopify mapping verification failed.");
  }, { isolationLevel: "serializable" });

  return {
    capturedAt: inventory.capturedAt,
    inventoryRows: inventory.items.length,
    mappedRows,
    conflictedRows,
    skippedMissingSku,
    distinctSkus: skus.size,
  };
}
