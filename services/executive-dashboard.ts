import "server-only";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventoryBalances, products as databaseProducts, shopifyMappings } from "@/db/schema";
import { getInventoryFeed } from "@/lib/inventory/live-data";
import { buildCommandCenterView } from "@/services/command-center";
import { fetchSalesReport } from "@/services/shopify-sales";
import { getWarehouseFoundationStatus } from "@/services/warehouse-foundation";
import type { ExecutiveDashboardData, ExecutiveRecommendation } from "@/types/executive";
import type { SalesReport } from "@/types/sales";

function packMultiplier(name: string): number {
  const match = name.match(/\bpack\s+of\s+(\d+)\b/i);
  return match ? Number(match[1]) : 1;
}

async function onlineLedgerByShopifyProduct(): Promise<Map<string, number>> {
  if (!process.env.DATABASE_URL?.trim()) return new Map();
  try {
    const db = getDatabase();
    const [mappings, balances] = await Promise.all([
      db.select({ productId: shopifyMappings.productId, shopifyProductId: shopifyMappings.shopifyProductId, productName: databaseProducts.name })
        .from(shopifyMappings).innerJoin(databaseProducts, eq(databaseProducts.id, shopifyMappings.productId)),
      db.select({ productId: inventoryBalances.productId, onHand: inventoryBalances.onHand })
        .from(inventoryBalances).where(eq(inventoryBalances.bucket, "online")),
    ]);
    const shopifyProductByBaseProduct = new Map<string, string>();
    for (const mapping of mappings) {
      if (packMultiplier(mapping.productName) === 1) shopifyProductByBaseProduct.set(mapping.productId, mapping.shopifyProductId);
    }
    const stock = new Map<string, number>();
    for (const balance of balances) {
      const shopifyProductId = shopifyProductByBaseProduct.get(balance.productId);
      if (shopifyProductId) stock.set(shopifyProductId, (stock.get(shopifyProductId) ?? 0) + balance.onHand);
    }
    return stock;
  } catch {
    return new Map();
  }
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator * 100).toFixed(1)) : 0;
}

function salesTrend(report: SalesReport) {
  const completedDays = report.daily.slice(0, -1);
  const current = completedDays.slice(-7);
  const previous = completedDays.slice(-14, -7);
  const currentSevenDayRevenue = current.reduce((sum, day) => sum + day.revenue - day.refunds, 0);
  const previousSevenDayRevenue = previous.reduce((sum, day) => sum + day.revenue - day.refunds, 0);
  const totalUnits = report.products.reduce((sum, product) => sum + product.units, 0);
  const topUnits = report.products[0]?.units ?? 0;
  return {
    currentSevenDayRevenue,
    previousSevenDayRevenue,
    revenueChangePercent: previous.length === 7 && previousSevenDayRevenue !== 0
      ? Number(((currentSevenDayRevenue - previousSevenDayRevenue) / previousSevenDayRevenue * 100).toFixed(1))
      : null,
    units: totalUnits,
    refundRatePercent: percent(report.refunds, report.grossRevenue),
    cancellationRatePercent: percent(report.cancelledOrders, report.orders),
    topProductSharePercent: percent(topUnits, totalUnits),
  };
}

function buildRecommendations(input: Omit<ExecutiveDashboardData, "recommendations" | "dataGaps" | "generatedAt">): ExecutiveRecommendation[] {
  const recommendations: ExecutiveRecommendation[] = [];
  const { view, warehouse, sales, trend, stockedProductsWithoutSales } = input;
  if (warehouse.failedShopifyWebhooks > 0) recommendations.push({ id: "webhooks", priority: "urgent", area: "Data quality", title: "Resolve failed Shopify stock events", evidence: `${warehouse.failedShopifyWebhooks} fulfillment or return event${warehouse.failedShopifyWebhooks === 1 ? " is" : "s are"} waiting for attention.`, action: "Review product mappings and Online balances before the next fulfillment." });
  if (view.outOfStockSkus > 0) recommendations.push({ id: "out-of-stock", priority: "urgent", area: "Inventory", title: "Recover out-of-stock listings", evidence: `${view.outOfStockSkus} Shopify inventory row${view.outOfStockSkus === 1 ? " is" : "s are"} at zero.`, action: "Prioritize production or approve a safe Buffer/Retail-to-Online transfer for the highest-demand products." });
  if (view.lowStockSkus > 0) recommendations.push({ id: "low-stock", priority: "important", area: "Inventory", title: "Protect the next 10 days of sales", evidence: `${view.lowStockSkus} inventory row${view.lowStockSkus === 1 ? " has" : "s have"} low cover.`, action: "Use Stock planning to replenish by demand rate and lead time, starting with the shortest days of cover." });
  if (view.missingSkus > 0) recommendations.push({ id: "missing-sku", priority: "important", area: "Data quality", title: "Complete SKU identities", evidence: `${view.missingSkus} tracked Shopify row${view.missingSkus === 1 ? " has" : "s have"} no SKU.`, action: "Assign unique SKUs in Shopify before those products are received or automatically allocated." });
  if (!sales) recommendations.push({ id: "sales-unavailable", priority: "urgent", area: "Sales", title: "Restore management sales visibility", evidence: input.salesError ?? "Shopify order analytics is unavailable.", action: "Confirm read_orders access and the installed Shopify app version." });
  if (sales && trend) {
    if (trend.revenueChangePercent !== null && trend.revenueChangePercent <= -10) recommendations.push({ id: "sales-decline", priority: "important", area: "Sales", title: "Investigate the seven-day sales decline", evidence: `Completed-day net sales fell ${Math.abs(trend.revenueChangePercent)}% versus the previous seven days.`, action: "Check source mix, product availability, pricing, and campaign activity before increasing spend." });
    if (trend.refundRatePercent >= 5) recommendations.push({ id: "refund-rate", priority: "important", area: "Sales", title: "Reduce refund leakage", evidence: `Refunds equal ${trend.refundRatePercent}% of gross Shopify revenue.`, action: "Review the most-refunded orders and products for quality, expectation, or fulfillment issues." });
    if (trend.cancellationRatePercent >= 5) recommendations.push({ id: "cancel-rate", priority: "important", area: "Sales", title: "Review order cancellations", evidence: `${trend.cancellationRatePercent}% of orders were cancelled in the reporting window.`, action: "Separate customer cancellations from stock and operational causes, then fix the largest category." });
    if (sales.marketing.attributionCoveragePercent < 70) recommendations.push({ id: "utm-coverage", priority: "important", area: "Marketing", title: "Improve campaign attribution", evidence: `Only ${sales.marketing.attributionCoveragePercent}% of eligible orders have a known Shopify journey source.`, action: "Use consistent UTM source, medium, and campaign tags on every paid, social, influencer, QR, and email link." });
    if (!sales.marketing.campaigns.length) recommendations.push({ id: "campaigns", priority: "opportunity", area: "Marketing", title: "Start campaign-level measurement", evidence: "No campaign-tagged orders were detected in the last 30 days.", action: "Adopt one UTM naming sheet and review revenue by campaign weekly." });
    if (trend.topProductSharePercent >= 40) recommendations.push({ id: "concentration", priority: "monitor", area: "Sales", title: "Protect against product concentration", evidence: `The top product contributes ${trend.topProductSharePercent}% of units sold.`, action: "Keep its stock protected while testing cross-sell bundles that grow the next two products." });
    if (stockedProductsWithoutSales > 0) recommendations.push({ id: "no-sales-stock", priority: "opportunity", area: "Inventory", title: "Activate stock with no recent sales", evidence: `${stockedProductsWithoutSales} active stocked product${stockedProductsWithoutSales === 1 ? " has" : "s have"} no Shopify units sold in 30 days.`, action: "Review listing quality, price, visibility, and bundle placement before producing more." });
    if (trend.revenueChangePercent !== null && trend.revenueChangePercent >= 15) recommendations.push({ id: "growth", priority: "opportunity", area: "Sales", title: "Support current sales momentum", evidence: `Completed-day net sales grew ${trend.revenueChangePercent}% versus the previous seven days.`, action: "Protect stock for winning products and scale only the sources with attributable revenue." });
  }
  if (!recommendations.length) recommendations.push({ id: "monitor", priority: "monitor", area: "Data quality", title: "No urgent exception detected", evidence: "Current sales, inventory, and integration checks are within configured limits.", action: "Continue daily monitoring and review product-level stock cover before new campaigns." });
  const order = { urgent: 0, important: 1, opportunity: 2, monitor: 3 } as const;
  return recommendations.sort((left, right) => order[left.priority] - order[right.priority]);
}

export async function getExecutiveDashboard(): Promise<ExecutiveDashboardData> {
  const [inventory, warehouse, salesResult, ledgerStock] = await Promise.all([
    getInventoryFeed(),
    getWarehouseFoundationStatus(),
    fetchSalesReport(30).then((sales) => ({ sales, error: null })).catch((error: unknown) => ({ sales: null, error: error instanceof Error ? error.message : "Shopify orders could not be loaded." })),
    onlineLedgerByShopifyProduct(),
  ]);
  const view = buildCommandCenterView(inventory, salesResult.sales, salesResult.error);
  const onlineStockByProduct = new Map<string, number>();
  for (const item of inventory.items.filter((item) => item.productStatus === "ACTIVE" && item.tracked !== false)) {
    onlineStockByProduct.set(item.productId, (onlineStockByProduct.get(item.productId) ?? 0) + item.today);
  }
  const productStockSource = ledgerStock.size ? "warehouse-ledger" as const : "shopify-listings" as const;
  const preferredStock = ledgerStock.size ? ledgerStock : onlineStockByProduct;
  const products = (salesResult.sales?.products ?? []).map((product) => ({
    ...product,
    onlineStock: product.productId ? preferredStock.get(product.productId) ?? 0 : null,
  }));
  const soldProductIds = new Set(products.filter((product) => product.productId && product.units > 0).map((product) => product.productId));
  const stockedProductsWithoutSales = [...preferredStock.entries()].filter(([productId, stock]) => stock > 0 && !soldProductIds.has(productId)).length;
  const base = {
    view,
    warehouse,
    sales: salesResult.sales,
    inventory,
    salesError: salesResult.error,
    trend: salesResult.sales ? salesTrend(salesResult.sales) : null,
    products,
    productStockSource,
    stockedProductsWithoutSales,
  };
  return {
    generatedAt: new Date().toISOString(),
    ...base,
    recommendations: buildRecommendations(base),
    dataGaps: [
      "Paid-ad spend, impressions, clicks, CAC, and ROAS require a Meta Ads or Google Ads connection.",
      "GA4 is required for traffic and funnel conversion; Google Search Console is required for SEO queries, impressions, clicks, CTR, and rankings.",
      "Offline retail revenue is not available until invoices or POS sales are captured; dispatches currently measure stock movement only.",
      "Gross margin requires product cost/COGS data, which is not currently stored in the command center.",
    ],
  };
}
