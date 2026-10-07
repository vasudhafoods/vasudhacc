import "server-only";
import { readRecentInventorySnapshots, toKolkataDateKey } from "@/services/inventory-snapshots";
import { readOperationsSettings } from "@/services/operations-store";
import type { CurrentInventoryResult } from "@/types/shopify";
import type { InventoryInsight } from "@/types/operations";
import { isPhysicalUnitProduct } from "@/lib/inventory/physical-units";

function key(item: { inventoryItemId: string; locationId: string }) {
  return `${item.inventoryItemId}::${item.locationId}`;
}

export async function buildInventoryInsights(current: CurrentInventoryResult): Promise<InventoryInsight[]> {
  const [snapshots, settings] = await Promise.all([readRecentInventorySnapshots(60), readOperationsSettings()]);
  const dated = snapshots.map((snapshot) => ({ date: snapshot.snapshotDate, items: new Map(snapshot.inventory.items.filter(item => isPhysicalUnitProduct(`${item.productTitle} ${item.variantTitle}`)).map((item) => [key(item), item.available])) }));

  return current.items.filter(item => isPhysicalUnitProduct(`${item.productTitle} ${item.variantTitle}`)).map((item) => {
    const itemKey = key(item);
    const series = dated.map((snapshot) => ({ date: snapshot.date, value: snapshot.items.get(itemKey) ?? 0 }));
    const currentDate = toKolkataDateKey(new Date(current.capturedAt));
    if (!series.length || series.at(-1)?.date !== currentDate) series.push({ date: currentDate, value: item.available });
    let depleted = 0;
    let daysWithoutMovement = 0;
    let lastMovementIndex = 0;
    for (let index = 1; index < series.length; index += 1) {
      const change = series[index - 1].value - series[index].value;
      if (change > 0) depleted += change;
      if (change !== 0) lastMovementIndex = index;
    }
    if (series.length > 1) {
      const lastMovementDate = new Date(`${series[lastMovementIndex].date}T00:00:00Z`);
      const latestDate = new Date(`${series.at(-1)?.date}T00:00:00Z`);
      daysWithoutMovement = Math.max(0, Math.round((latestDate.getTime() - lastMovementDate.getTime()) / 86_400_000));
    }
    const elapsedDays = series.length > 1
      ? Math.max(1, Math.round((new Date(`${series.at(-1)?.date}T00:00:00Z`).getTime() - new Date(`${series[0].date}T00:00:00Z`).getTime()) / 86_400_000))
      : 0;
    const averageDailySales = elapsedDays ? depleted / elapsedDays : 0;
    const daysUntilStockout = averageDailySales > 0 ? item.available / averageDailySales : null;
    const targetStock = averageDailySales * (settings.leadTimeDays + settings.safetyStockDays);
    return {
      productId: item.productId,
      inventoryItemId: item.inventoryItemId,
      locationId: item.locationId,
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      sku: item.sku,
      locationName: item.locationName,
      imageUrl: item.imageUrl,
      currentStock: item.available,
      averageDailySales: Number(averageDailySales.toFixed(2)),
      daysUntilStockout: daysUntilStockout === null ? null : Number(daysUntilStockout.toFixed(1)),
      reorderQuantity: Math.max(0, Math.ceil(targetStock - item.available)),
      daysWithoutMovement,
      inventoryAgeDays: item.inventoryItemCreatedAt ? Math.max(0, Math.floor((new Date(current.capturedAt).getTime() - new Date(item.inventoryItemCreatedAt).getTime()) / 86_400_000)) : null,
      deadStock: elapsedDays >= settings.deadStockDays && item.available > 0 && depleted === 0,
      historyDays: elapsedDays,
    };
  }).sort((a, b) => {
    const left = a.daysUntilStockout ?? Number.POSITIVE_INFINITY;
    const right = b.daysUntilStockout ?? Number.POSITIVE_INFINITY;
    return left - right || b.reorderQuantity - a.reorderQuantity;
  });
}
