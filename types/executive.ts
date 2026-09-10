import type { CommandCenterView } from "@/types/command-center";
import type { InventoryFeed } from "@/lib/inventory/live-data";
import type { SalesReport } from "@/types/sales";
import type { WarehouseFoundationStatus } from "@/services/warehouse-foundation";

export type ExecutiveRecommendationPriority = "urgent" | "important" | "opportunity" | "monitor";

export interface ExecutiveRecommendation {
  id: string;
  priority: ExecutiveRecommendationPriority;
  area: "Inventory" | "Sales" | "Marketing" | "Data quality";
  title: string;
  evidence: string;
  action: string;
}

export interface ExecutiveSalesTrend {
  currentSevenDayRevenue: number;
  previousSevenDayRevenue: number;
  revenueChangePercent: number | null;
  units: number;
  refundRatePercent: number;
  cancellationRatePercent: number;
  topProductSharePercent: number;
}

export interface ExecutiveProductRow {
  productId: string | null;
  title: string;
  units: number;
  revenue: number;
  onlineStock: number | null;
}

export interface ExecutiveDashboardData {
  generatedAt: string;
  view: CommandCenterView;
  warehouse: WarehouseFoundationStatus;
  sales: SalesReport | null;
  inventory: InventoryFeed;
  salesError: string | null;
  trend: ExecutiveSalesTrend | null;
  products: ExecutiveProductRow[];
  productStockSource: "warehouse-ledger" | "shopify-listings";
  stockedProductsWithoutSales: number;
  recommendations: ExecutiveRecommendation[];
  dataGaps: string[];
}
