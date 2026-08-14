export type CommandCenterHealth = "healthy" | "monitor" | "low" | "critical" | "urgent" | "out-of-stock";

export interface CommandCenterDecision {
  id: string;
  inventoryItemId: string;
  productId: string;
  productTitle: string;
  sku: string | null;
  health: CommandCenterHealth;
  onlineStock: number;
  averageDailyUnits: number;
  daysCover: number | null;
  problem: string;
  reason: string;
  recommendation: string;
}

export interface CommandCenterView {
  capturedAt: string | null;
  mode: "live" | "snapshot" | "error";
  onlineStock: number;
  onlineUnitsToday: number | null;
  shopifyOrdersToday: number | null;
  averageDailyOnlineUnits: number | null;
  lowStockSkus: number;
  outOfStockSkus: number;
  mappedSkus: number;
  missingSkus: number;
  decisions: CommandCenterDecision[];
  salesError: string | null;
}
