import "server-only";
import { shopifyGraphQL } from "@/lib/shopify/client";
import { ORDERS_QUERY } from "@/lib/shopify/queries";
import type { SalesOrder, SalesReport } from "@/types/sales";
import type { ShopifyPageInfo } from "@/types/shopify";

interface Money { amount: string; currencyCode: string }
interface OrderNode {
  id: string; name: string; processedAt: string; cancelledAt: string | null;
  totalPriceSet: { shopMoney: Money };
  currentTotalPriceSet: { shopMoney: Money };
  customerJourneySummary: {
    ready: boolean;
    customerOrderIndex: number | null;
    daysToConversion: number | null;
    lastVisit: {
      source: string;
      sourceDescription: string | null;
      sourceType: string | null;
      utmParameters: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null } | null;
    } | null;
  } | null;
  refunds: { processedAt: string; totalRefundedSet: { shopMoney: Money } }[];
  lineItems: { nodes: { title: string; variantTitle: string | null; sku: string | null; quantity: number; currentQuantity: number; discountedTotalSet: { shopMoney: Money }; product: { id: string; title: string } | null; variant: { id: string } | null }[] };
}
interface OrdersResponse { orders: { nodes: OrderNode[]; pageInfo: ShopifyPageInfo } }

function amount(value: string) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

function cleanLabel(value: string | null | undefined): string | null {
  const label = value?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.replace(/\b\w/g, (letter) => letter.toUpperCase()) : null;
}

export async function fetchSalesReport(days = 30): Promise<SalesReport> {
  const toDate = new Date();
  const fromDate = new Date(toDate); fromDate.setUTCDate(fromDate.getUTCDate() - Math.max(1, Math.min(days, 60)) + 1);
  const from = fromDate.toISOString().slice(0, 10); const to = toDate.toISOString().slice(0, 10);
  const orders: SalesOrder[] = [];
  let pageInfo: ShopifyPageInfo = { hasNextPage: true, endCursor: null };
  while (pageInfo.hasNextPage) {
    const data = await shopifyGraphQL<OrdersResponse>(ORDERS_QUERY, { first: 50, after: pageInfo.endCursor, query: `processed_at:>=${from} processed_at:<=${to}` });
    for (const order of data.orders.nodes) {
      const visit = order.customerJourneySummary?.lastVisit;
      const utm = visit?.utmParameters;
      orders.push({
        id: order.id,
        name: order.name,
        processedAt: order.processedAt,
        cancelledAt: order.cancelledAt,
        revenue: amount(order.totalPriceSet.shopMoney.amount),
        refunds: order.refunds.reduce((sum, refund) => sum + amount(refund.totalRefundedSet.shopMoney.amount), 0),
        currency: order.totalPriceSet.shopMoney.currencyCode,
        lines: order.lineItems.nodes.map((line) => ({ productId: line.product?.id ?? null, variantId: line.variant?.id ?? null, productTitle: line.product?.title ?? line.title, variantTitle: line.variantTitle, sku: line.sku, quantity: line.quantity, currentQuantity: line.currentQuantity, revenue: amount(line.discountedTotalSet.shopMoney.amount) })),
        attribution: order.customerJourneySummary ? {
          ready: order.customerJourneySummary.ready,
          customerOrderIndex: order.customerJourneySummary.customerOrderIndex,
          daysToConversion: order.customerJourneySummary.daysToConversion,
          source: cleanLabel(utm?.source ?? visit?.sourceDescription ?? visit?.source),
          medium: cleanLabel(utm?.medium ?? visit?.sourceType),
          campaign: cleanLabel(utm?.campaign),
        } : null,
      });
    }
    pageInfo = data.orders.pageInfo;
  }
  const currency = orders[0]?.currency ?? "INR";
  const dailyMap = new Map<string, { date: string; orders: number; units: number; revenue: number; refunds: number }>();
  for (let cursor = new Date(`${from}T00:00:00Z`); cursor <= toDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) { const date = cursor.toISOString().slice(0, 10); dailyMap.set(date, { date, orders: 0, units: 0, revenue: 0, refunds: 0 }); }
  const productMap = new Map<string, { productId: string | null; title: string; units: number; revenue: number }>();
  for (const order of orders) {
    const day = dailyMap.get(order.processedAt.slice(0, 10)); if (day) { day.orders += 1; day.units += order.cancelledAt ? 0 : order.lines.reduce((sum, line) => sum + line.currentQuantity, 0); day.revenue += order.revenue; day.refunds += order.refunds; }
    for (const line of order.lines) { const key = line.productId ?? line.productTitle; const product = productMap.get(key) ?? { productId: line.productId, title: line.productTitle, units: 0, revenue: 0 }; product.units += order.cancelledAt ? 0 : line.currentQuantity; product.revenue += order.cancelledAt ? 0 : line.revenue; productMap.set(key, product); }
  }
  const grossRevenue = orders.reduce((sum, order) => sum + order.revenue, 0); const refunds = orders.reduce((sum, order) => sum + order.refunds, 0); const netRevenue = grossRevenue - refunds;
  const eligibleOrders = orders.filter((order) => !order.cancelledAt);
  const sourceMap = new Map<string, { label: string; orders: number; units: number; revenue: number }>();
  const campaignMap = new Map<string, { label: string; orders: number; units: number; revenue: number }>();
  let attributedOrders = 0;
  let newCustomerOrders = 0;
  let returningCustomerOrders = 0;
  let unknownCustomerTypeOrders = 0;
  const conversionDays: number[] = [];
  for (const order of eligibleOrders) {
    const attribution = order.attribution;
    if (attribution?.ready && attribution.source) {
      attributedOrders += 1;
      const source = sourceMap.get(attribution.source) ?? { label: attribution.source, orders: 0, units: 0, revenue: 0 };
      source.orders += 1;
      source.units += order.lines.reduce((sum, line) => sum + line.currentQuantity, 0);
      source.revenue += Math.max(0, order.revenue - order.refunds);
      sourceMap.set(attribution.source, source);
      if (attribution.campaign) {
        const campaignLabel = attribution.medium ? `${attribution.campaign} · ${attribution.medium}` : attribution.campaign;
        const campaign = campaignMap.get(campaignLabel) ?? { label: campaignLabel, orders: 0, units: 0, revenue: 0 };
        campaign.orders += 1;
        campaign.units += order.lines.reduce((sum, line) => sum + line.currentQuantity, 0);
        campaign.revenue += Math.max(0, order.revenue - order.refunds);
        campaignMap.set(campaignLabel, campaign);
      }
    }
    if (attribution?.customerOrderIndex === 1) newCustomerOrders += 1;
    else if (attribution?.customerOrderIndex && attribution.customerOrderIndex > 1) returningCustomerOrders += 1;
    else unknownCustomerTypeOrders += 1;
    if (typeof attribution?.daysToConversion === "number") conversionDays.push(attribution.daysToConversion);
  }
  const marketing = {
    eligibleOrders: eligibleOrders.length,
    attributedOrders,
    unattributedOrders: Math.max(0, eligibleOrders.length - attributedOrders),
    attributionCoveragePercent: eligibleOrders.length ? Number((attributedOrders / eligibleOrders.length * 100).toFixed(1)) : 0,
    newCustomerOrders,
    returningCustomerOrders,
    unknownCustomerTypeOrders,
    averageDaysToConversion: conversionDays.length ? Number((conversionDays.reduce((sum, value) => sum + value, 0) / conversionDays.length).toFixed(1)) : null,
    sources: [...sourceMap.values()].sort((left, right) => right.revenue - left.revenue),
    campaigns: [...campaignMap.values()].sort((left, right) => right.revenue - left.revenue),
  };
  return { from, to, currency, orders: orders.length, cancelledOrders: orders.filter((order) => order.cancelledAt).length, grossRevenue, refunds, netRevenue, averageOrderValue: orders.length ? netRevenue / orders.length : 0, projected30DayRevenue: netRevenue / Math.max(1, days) * 30, daily: [...dailyMap.values()], products: [...productMap.values()].sort((a, b) => b.units - a.units), marketing };
}
