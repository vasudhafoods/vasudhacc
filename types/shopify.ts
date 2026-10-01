export interface ShopifyPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ShopifyInventoryLevelNode {
  id: string;
  location: { id: string; name: string };
  quantities: { name: string; quantity: number }[];
}

export interface ShopifyInventoryLevelConnection {
  nodes: ShopifyInventoryLevelNode[];
  pageInfo: ShopifyPageInfo;
}

export interface ShopifyVariantNode {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  media: { nodes: ShopifyMediaNode[] };
  product: {
    id: string;
    title: string;
    status: ShopifyProductStatus;
    createdAt: string;
    publishedAt: string | null;
    media: { nodes: ShopifyMediaNode[] };
  };
  inventoryItem: {
    id: string;
    sku: string | null;
    tracked: boolean;
    createdAt: string;
    updatedAt: string;
    inventoryLevels: ShopifyInventoryLevelConnection;
  } | null;
}

export type ShopifyProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";

interface ShopifyMediaNode {
  preview: { image: { url: string } | null } | null;
}

export interface CurrentInventoryItem {
  productId: string;
  variantId: string;
  inventoryItemId: string;
  inventoryLevelId: string;
  locationId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  price: string;
  imageUrl: string | null;
  locationName: string;
  available: number;
  tracked: boolean;
  productStatus?: ShopifyProductStatus;
  productCreatedAt?: string;
  productPublishedAt?: string | null;
  inventoryItemCreatedAt?: string;
  inventoryItemUpdatedAt?: string;
}

export interface CurrentInventoryResult {
  capturedAt: string;
  store: { name: string; domain: string };
  summary: {
    totalInventory: number;
    totalProducts: number;
    totalVariants: number;
    totalInventoryItems: number;
    totalLocations: number;
  };
  diagnostics: {
    missingInventoryItems: number;
    inventoryItemsWithoutLevels: number;
    missingSkus: number;
    missingImages: number;
    untrackedInventoryItems: number;
  };
  items: CurrentInventoryItem[];
}
