import "server-only";
import { getInventoryFeed } from "@/lib/inventory/live-data";
import { fetchSalesReport } from "@/services/shopify-sales";
import type { CommandCenterDecision, CommandCenterHealth, CommandCenterView } from "@/types/command-center";
import type { SalesReport } from "@/types/sales";

function healthFor(stock: number, daysCover: number | null): CommandCenterHealth {
  if (stock <= 0) return "out-of-stock";
  if (daysCover === null) return "monitor";
  if (daysCover < 3) return "urgent";
  if (daysCover < 5) return "critical";
  if (daysCover < 10) return "low";
  if (daysCover <= 15) return "monitor";
  return "healthy";
}

function buildDecisions(
  items: Awaited<ReturnType<typeof getInventoryFeed>>["items"],
  report: SalesReport | null,
): CommandCenterDecision[] {
  const unitsByProduct = new Map((report?.products ?? []).map((product) => [product.productId, product.units]));
  const days = report ? Math.max(1, report.daily.length) : 0;

  return items.map((item) => {
    const averageDailyUnits = days ? (unitsByProduct.get(item.productId) ?? 0) / days : 0;
    const daysCover = averageDailyUnits > 0 ? item.today / averageDailyUnits : null;
    const health = healthFor(item.today, daysCover);
    return {
      id: `${item.inventoryItemId}:${item.locationId}`,
      inventoryItemId: item.inventoryItemId,
      productId: item.productId,
      productTitle: item.productTitle,
      sku: item.sku,
      health,
      onlineStock: item.today,
      averageDailyUnits: Number(averageDailyUnits.toFixed(1)),
      daysCover: daysCover === null ? null : Number(daysCover.toFixed(1)),
      problem: item.today <= 0 ? "Online stock is out" : `Online stock is ${health}`,
      reason: daysCover === null
        ? "There is not enough recent Shopify demand to calculate reliable cover."
        : `${item.today} units remain at an average of ${averageDailyUnits.toFixed(1)} units per day (${daysCover.toFixed(1)} days cover).`,
      recommendation: "Review Buffer and Retail availability; approve a transfer only after warehouse balances and Shopify committed stock are connected.",
    };
  }).filter((decision) => ["out-of-stock", "urgent", "critical", "low"].includes(decision.health))
    .sort((left, right) => (left.daysCover ?? Number.POSITIVE_INFINITY) - (right.daysCover ?? Number.POSITIVE_INFINITY))
    .slice(0, 8);
}

export async function getCommandCenterView(): Promise<CommandCenterView> {
  const [feed, salesResult] = await Promise.all([
    getInventoryFeed(),
    fetchSalesReport(30).then((report) => ({ report, error: null })).catch((error: unknown) => ({ report: null, error: error instanceof Error ? error.message : "Shopify orders could not be loaded." })),
  ]);
  const today = salesResult.report?.daily.at(-1);
  const trackedItems = feed.items.filter((item) => item.tracked !== false);

  return {
    capturedAt: feed.liveCapturedAt,
    mode: feed.mode === "current" ? "live" : feed.mode,
    onlineStock: feed.summary.today,
    onlineUnitsToday: today?.units ?? null,
    shopifyOrdersToday: today?.orders ?? null,
    averageDailyOnlineUnits: salesResult.report ? Number((salesResult.report.daily.reduce((sum, day) => sum + day.units, 0) / Math.max(1, salesResult.report.daily.length)).toFixed(1)) : null,
    lowStockSkus: feed.summary.lowStock,
    outOfStockSkus: feed.summary.outOfStock,
    mappedSkus: trackedItems.filter((item) => Boolean(item.sku)).length,
    missingSkus: trackedItems.filter((item) => !item.sku).length,
    decisions: buildDecisions(feed.items, salesResult.report),
    salesError: salesResult.error,
  };
}
