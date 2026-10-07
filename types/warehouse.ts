export type ShopifySyncStatus = "not_required" | "pending" | "succeeded" | "failed";

export interface WarehouseProductOption {
  id: string;
  sku: string;
  name: string;
  packSize: string | null;
  category: "noodles" | "cookies" | "rte" | "other";
  unitPricePaisa: number;
  shopifyMappingId: string | null;
  /** Listed on Shopify. Products that are not are retail-only. */
  onShopify: boolean;
}

export interface WarehouseRetailBalance {
  productId: string;
  warehouseLocationId: string;
  available: number;
}

export type WarehouseInventoryBucket = "online" | "retail" | "buffer" | "qc" | "damaged";

export interface WarehouseBucketBalance {
  productId: string;
  warehouseLocationId: string;
  bucket: WarehouseInventoryBucket;
  onHand: number;
  reserved: number;
  available: number;
}

export interface WarehouseLocationOption {
  id: string;
  code: string;
  name: string;
}

export interface WarehouseActivity {
  id: string;
  kind: "stock_received" | "retail_dispatched" | "stock_transferred" | "return_received" | "qc_released" | "stock_disposed" | "product_created";
  title: string;
  reference: string;
  occurredAt: string;
  details: string[];
}

export interface WarehouseWorkspaceData {
  products: WarehouseProductOption[];
  locations: WarehouseLocationOption[];
  retailBalances: WarehouseRetailBalance[];
  balances: WarehouseBucketBalance[];
  expiries: { productId: string; warehouseLocationId: string; batchNumber: string; expiryDate: string; remainingQuantity: number }[];
  activities: WarehouseActivity[];
  salesOrders: import("@/types/offline-sales").OfflineSaleRow[];
  salesOrdersMigrationPending: boolean;
  shopifyOrders: ShopifyWarehouseOrder[];
  shopifyOrdersError: string | null;
  orderDocuments: Record<string, { fileName: string; url: string }>;
}

export interface ShopifyWarehouseOrder {
  id: string;
  name: string;
  createdAt: string;
  customerName: string;
  destination: string;
  total: string;
  currency: string;
  fulfillmentStatus: string;
  financialStatus: string | null;
  deliveryStatus: string | null;
  sourceName: string;
  trackingInfo: { company: string | null; number: string | null; url: string | null }[];
  itemCount: number;
  lines: { title: string; variantTitle: string | null; sku: string | null; quantity: number }[];
}
