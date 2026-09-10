export type ShopifySyncStatus = "not_required" | "pending" | "succeeded" | "failed";

export interface WarehouseProductOption {
  id: string;
  sku: string;
  name: string;
  packSize: string | null;
  shopifyMappingId: string | null;
}

export interface WarehouseRetailBalance {
  productId: string;
  warehouseLocationId: string;
  available: number;
}

export interface WarehouseLocationOption {
  id: string;
  code: string;
  name: string;
}

export interface WarehouseActivity {
  id: string;
  kind: "stock_received" | "retail_dispatched" | "product_created";
  title: string;
  reference: string;
  occurredAt: string;
  details: string[];
}

export interface WarehouseWorkspaceData {
  products: WarehouseProductOption[];
  locations: WarehouseLocationOption[];
  retailBalances: WarehouseRetailBalance[];
  activities: WarehouseActivity[];
}
