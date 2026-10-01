import "server-only";
import { shopifyGraphQL } from "@/lib/shopify/client";
import { CATALOG_VARIANT_PRICES_QUERY, INVENTORY_LEVELS_QUERY, INVENTORY_VARIANTS_QUERY } from "@/lib/shopify/queries";
import { getShopifyConfig } from "@/lib/validation/env";
import type { CurrentInventoryItem, CurrentInventoryResult, ShopifyInventoryLevelConnection, ShopifyInventoryLevelNode, ShopifyPageInfo, ShopifyVariantNode } from "@/types/shopify";

const VARIANT_PAGE_SIZE = 50;
const INITIAL_LEVEL_PAGE_SIZE = 10;
const LEVEL_PAGE_SIZE = 100;

interface VariantsResponse {
  shop: { name: string; myshopifyDomain: string };
  productVariants: { nodes: ShopifyVariantNode[]; pageInfo: ShopifyPageInfo };
}
interface LevelsResponse { inventoryItem: { inventoryLevels: ShopifyInventoryLevelConnection } | null; }
interface VariantPricesResponse { productVariants: { nodes: { sku: string | null; price: string; inventoryItem: { sku: string | null } | null }[]; pageInfo: ShopifyPageInfo }; }

export async function fetchShopifyPricesBySku(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  let cursor: string | null = null;
  let pageInfo: ShopifyPageInfo = { hasNextPage: true, endCursor: null };
  while (pageInfo.hasNextPage) {
    const data = await shopifyGraphQL<VariantPricesResponse>(CATALOG_VARIANT_PRICES_QUERY, { first: 100, after: cursor });
    for (const variant of data.productVariants.nodes) {
      const amount = Number(variant.price);
      if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(?:\.\d{1,2})?$/.test(variant.price)) continue;
      const pricePaisa = Math.round(amount * 100);
      for (const rawSku of [variant.sku, variant.inventoryItem?.sku]) {
        const sku = rawSku?.trim().toUpperCase();
        if (sku) prices.set(sku, pricePaisa);
      }
    }
    pageInfo = data.productVariants.pageInfo;
    cursor = pageInfo.endCursor;
  }
  return prices;
}

async function loadRemainingLevels(inventoryItemId: string, initial: ShopifyInventoryLevelConnection): Promise<ShopifyInventoryLevelNode[]> {
  const levels = [...initial.nodes];
  let pageInfo = initial.pageInfo;
  while (pageInfo.hasNextPage) {
    const data: LevelsResponse = await shopifyGraphQL<LevelsResponse>(INVENTORY_LEVELS_QUERY, { inventoryItemId, first: LEVEL_PAGE_SIZE, after: pageInfo.endCursor });
    if (!data.inventoryItem) break;
    levels.push(...data.inventoryItem.inventoryLevels.nodes);
    pageInfo = data.inventoryItem.inventoryLevels.pageInfo;
  }
  return levels;
}

function imageUrl(variant: ShopifyVariantNode): string | null {
  return variant.media.nodes[0]?.preview?.image?.url ?? variant.product.media.nodes[0]?.preview?.image?.url ?? null;
}

function normalizeLevel(variant: ShopifyVariantNode, level: ShopifyInventoryLevelNode): CurrentInventoryItem | null {
  const inventoryItem = variant.inventoryItem;
  if (!inventoryItem) return null;
  const available = level.quantities.find((quantity) => quantity.name === "available")?.quantity ?? 0;
  return {
    productId: variant.product.id,
    variantId: variant.id,
    inventoryItemId: inventoryItem.id,
    inventoryLevelId: level.id,
    locationId: level.location.id,
    productTitle: variant.product.title,
    variantTitle: variant.title,
    sku: inventoryItem.sku ?? variant.sku ?? null,
    price: variant.price,
    imageUrl: imageUrl(variant),
    locationName: level.location.name,
    available,
    tracked: inventoryItem.tracked,
    productStatus: variant.product.status,
    productCreatedAt: variant.product.createdAt,
    productPublishedAt: variant.product.publishedAt,
    inventoryItemCreatedAt: inventoryItem.createdAt,
    inventoryItemUpdatedAt: inventoryItem.updatedAt,
  };
}

export async function fetchCurrentInventory(): Promise<CurrentInventoryResult> {
  const config = getShopifyConfig();
  const variants: ShopifyVariantNode[] = [];
  let cursor: string | null = null;
  let pageInfo: ShopifyPageInfo = { hasNextPage: true, endCursor: null };
  let shop: VariantsResponse["shop"] | null = null;

  while (pageInfo.hasNextPage) {
    const data: VariantsResponse = await shopifyGraphQL<VariantsResponse>(INVENTORY_VARIANTS_QUERY, { first: VARIANT_PAGE_SIZE, after: cursor, levelsFirst: INITIAL_LEVEL_PAGE_SIZE });
    shop ??= data.shop;
    variants.push(...data.productVariants.nodes);
    pageInfo = data.productVariants.pageInfo;
    cursor = pageInfo.endCursor;
  }

  const items: CurrentInventoryItem[] = [];
  let missingInventoryItems = 0;
  let inventoryItemsWithoutLevels = 0;
  for (const variant of variants) {
    if (!variant.inventoryItem) { missingInventoryItems += 1; continue; }
    const levels = await loadRemainingLevels(variant.inventoryItem.id, variant.inventoryItem.inventoryLevels);
    if (levels.length === 0) inventoryItemsWithoutLevels += 1;
    for (const level of levels) {
      const item = normalizeLevel(variant, level);
      if (item) items.push(item);
    }
  }

  const products = new Set(variants.map((variant) => variant.product.id));
  const inventoryItems = new Set(items.map((item) => item.inventoryItemId));
  const locations = new Set(items.map((item) => item.locationId));
  return {
    capturedAt: new Date().toISOString(),
    store: { name: shop?.name ?? config.storeDomain, domain: shop?.myshopifyDomain ?? config.storeDomain },
    summary: {
      totalInventory: items.reduce((sum, item) => sum + item.available, 0),
      totalProducts: products.size,
      totalVariants: variants.length,
      totalInventoryItems: inventoryItems.size,
      totalLocations: locations.size,
    },
    diagnostics: {
      missingInventoryItems,
      inventoryItemsWithoutLevels,
      missingSkus: variants.filter((variant) => !(variant.inventoryItem?.sku ?? variant.sku)).length,
      missingImages: variants.filter((variant) => !imageUrl(variant)).length,
      untrackedInventoryItems: variants.filter((variant) => variant.inventoryItem && !variant.inventoryItem.tracked).length,
    },
    items,
  };
}
