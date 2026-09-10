import type { InventoryBucket, InventoryTransactionType } from "@/db/schema";
import type { InventoryStatus } from "@/types/inventory";

export interface PhysicalInventoryProduct {
  id: string;
  sku: string;
  name: string;
  displayName: string;
  packSize: string | null;
  locations: string[];
  online: number;
  retail: number;
  buffer: number;
  qc: number;
  damaged: number;
  actual: number;
  status: InventoryStatus;
  updatedAt: string;
}

export interface PhysicalInventoryMovement {
  id: string;
  occurredAt: string;
  type: InventoryTransactionType;
  transactionNumber: string;
  referenceId: string | null;
  reason: string;
  locationName: string;
  bucket: InventoryBucket;
  quantityDelta: number;
  closingBalance: number;
}
