import { receiptAllocation } from "@/lib/inventory/allocation";

export type ChannelBucket = "online" | "retail" | "buffer";

export interface ChannelBalanceForRotation {
  bucket: ChannelBucket;
  onHand: number;
  reserved: number;
}

// Keep 40/40/20 of unreserved physical packets in Online, Retail, and Buffer.
// Reserved packets stay in their current bucket so open orders remain fulfillable.
export function targetChannelBalances(balances: ChannelBalanceForRotation[]) {
  const current = new Map(balances.map((balance) => [balance.bucket, balance]));
  const reserved = {
    online: current.get("online")?.reserved ?? 0,
    retail: current.get("retail")?.reserved ?? 0,
    buffer: current.get("buffer")?.reserved ?? 0,
  };
  const available = ["online", "retail", "buffer"].reduce((total, bucket) => {
    const balance = current.get(bucket as ChannelBucket);
    return total + Math.max(0, (balance?.onHand ?? 0) - (balance?.reserved ?? 0));
  }, 0);
  const allocation = receiptAllocation(available);
  return {
    online: reserved.online + allocation.online,
    retail: reserved.retail + allocation.retail,
    buffer: reserved.buffer + allocation.buffer,
    available,
  };
}
