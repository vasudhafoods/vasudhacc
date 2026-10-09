import type { WarehouseBucketBalance, WarehouseInventoryBucket } from "@/types/warehouse";

export const BUCKET_LABELS: Record<WarehouseInventoryBucket, string> = {
  online: "Shopify / Online", retail: "Retail", buffer: "Buffer", qc: "QC / Hold", damaged: "Damaged",
};

// Damaged stock must pass through QC before it can become sellable again.
export function conditionDestinations(source: WarehouseInventoryBucket): WarehouseInventoryBucket[] {
  if (source === "damaged") return ["qc"];
  if (source === "qc") return ["damaged", "buffer"];
  return ["damaged", "qc"];
}

export function isConditionTransfer(from: unknown, to: unknown): boolean {
  return typeof from === "string" && Object.hasOwn(BUCKET_LABELS, from)
    && conditionDestinations(from as WarehouseInventoryBucket).includes(to as WarehouseInventoryBucket);
}

export function bucketAvailable(balances: WarehouseBucketBalance[], productId: string, locationId: string, bucket: WarehouseInventoryBucket): number {
  const balance = balances.find(row => row.productId === productId && row.warehouseLocationId === locationId && row.bucket === bucket);
  return balance ? Math.max(0, balance.onHand - balance.reserved) : 0;
}
