import "server-only";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventoryBalances, products, shopifyMappings } from "@/db/schema";
import type { ProductPhysicalStock } from "@/types/inventory";

function isBasePacketProduct(name: string): boolean {
  const pack = name.match(/\bpack\s+of\s+(\d+)\b/i);
  return !pack || Number(pack[1]) === 1;
}

function emptyStock(shopifyProductId: string): ProductPhysicalStock {
  return { shopifyProductId, recorded: false, actual: 0, online: 0, retail: 0, buffer: 0, qc: 0, damaged: 0 };
}

export async function getProductPhysicalStock(): Promise<Record<string, ProductPhysicalStock>> {
  if (!process.env.DATABASE_URL?.trim()) return {};
  try {
    const db = getDatabase();
    const [mappingRows, balanceRows] = await Promise.all([
      db.select({ productId: shopifyMappings.productId, shopifyProductId: shopifyMappings.shopifyProductId, productName: products.name })
        .from(shopifyMappings)
        .innerJoin(products, eq(products.id, shopifyMappings.productId)),
      db.select({ productId: inventoryBalances.productId, bucket: inventoryBalances.bucket, onHand: inventoryBalances.onHand })
        .from(inventoryBalances),
    ]);
    const shopifyProductByBaseProduct = new Map<string, string>();
    const result: Record<string, ProductPhysicalStock> = {};
    for (const mapping of mappingRows) {
      if (!isBasePacketProduct(mapping.productName)) continue;
      shopifyProductByBaseProduct.set(mapping.productId, mapping.shopifyProductId);
      result[mapping.shopifyProductId] ??= emptyStock(mapping.shopifyProductId);
    }
    for (const balance of balanceRows) {
      const shopifyProductId = shopifyProductByBaseProduct.get(balance.productId);
      if (!shopifyProductId) continue;
      const stock = result[shopifyProductId] ?? emptyStock(shopifyProductId);
      stock.recorded = true;
      stock[balance.bucket] += balance.onHand;
      stock.actual = stock.online + stock.retail + stock.buffer + stock.qc;
      result[shopifyProductId] = stock;
    }
    return result;
  } catch {
    return {};
  }
}
