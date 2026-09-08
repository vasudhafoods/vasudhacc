export interface WarehouseProductOption {
  id: string;
  sku: string;
  name: string;
  packSize: string | null;
  shopifyMappingId: string | null;
}

export interface WarehouseLocationOption {
  id: string;
  code: string;
  name: string;
}

export interface WarehouseActivity {
  id: string;
  kind: "stock_received" | "product_created";
  title: string;
  reference: string;
  occurredAt: string;
  details: string[];
}

export interface WarehouseWorkspaceData {
  products: WarehouseProductOption[];
  locations: WarehouseLocationOption[];
  activities: WarehouseActivity[];
}
