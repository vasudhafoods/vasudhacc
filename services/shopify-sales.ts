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
  refunds: { processedAt: string; totalRefundedSet: { shopMoney: Money } }[];
  lineItems: { nodes: { title: string; variantTitle: string | null; sku: string | null; quantity: number; currentQuantity: number; discountedTotalSet: { shopMoney: Money }; product: { id: string; title: string } | null; variant: { id: string } | null }[] };
}
interface OrdersResponse { orders: { nodes: OrderNode[]; pageInfo: ShopifyPageInfo } }

function amount(value: string) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

export async function fetchSalesReport(days = 30): Promise<SalesReport> {
  const toDate = new Date();
  const fromDate = new Date(toDate); fromDate.setUTCDate(fromDate.getUTCDate() - Math.max(1, Math.min(days, 60)) + 1);
  const from = fromDate.toISOString().slice(0, 10); const to = toDate.toISOString().slice(0, 10);
  const orders: SalesOrder[] = [];
  let pageInfo: ShopifyPageInfo = { hasNextPage: true, endCursor: null };
  while (pageInfo.hasNextPage) {
    const data = await shopifyGraphQL<OrdersResponse>(ORDERS_QUERY, { first: 50, after: pageInfo.endCursor, query: `processed_at:>=${from} processed_at:<=${to}` });
    for (const order of data.orders.nodes) {
      orders.push({ id: order.id, name: order.name, processedAt: order.processedAt, cancelledAt: order.cancelledAt, revenue: amount(order.totalPriceSet.shopMoney.amount), refunds: order.refunds.reduce((sum, refund) => sum + amount(refund.totalRefundedSet.shopMoney.amount), 0), currency: order.totalPriceSet.shopMoney.currencyCode, lines: order.lineItems.nodes.map((line) => ({ productId: line.product?.id ?? null, variantId: line.variant?.id ?? null, productTitle: line.product?.title ?? line.title, variantTitle: line.variantTitle, sku: line.sku, quantity: line.quantity, currentQuantity: line.currentQuantity, revenue: amount(line.discountedTotalSet.shopMoney.amount) })) });
    }
    pageInfo = data.orders.pageInfo;
  }
  const currency = orders[0]?.currency ?? "INR";
  const dailyMap = new Map<string, { date: string; orders: number; units: number; revenue: number; refunds: number }>();
  for (let cursor = new Date(`${from}T00:00:00Z`); cursor <= toDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) { const date = cursor.toISOString().slice(0, 10); dailyMap.set(date, { date, orders: 0, units: 0, revenue: 0, refunds: 0 }); }
  const productMap = new Map<string, { productId: string | null; title: string; units: number; revenue: number }>();
  for (const order of orders) {
    const day = dailyMap.get(order.processedAt.slice(0, 10)); if (day) { day.orders += 1; day.units += order.cancelledAt ? 0 : order.lines.reduce((sum, line) => sum + line.currentQuantity, 0); day.revenue += order.revenue; day.refunds += order.refunds; }
    for (const line of order.lines) { const key = line.productId ?? line.productTitle; const product = productMap.get(key) ?? { productId: line.productId, title: line.productTitle, units: 0, revenue: 0 }; product.units += line.quantity; product.revenue += line.revenue; productMap.set(key, product); }
  }
  const grossRevenue = orders.reduce((sum, order) => sum + order.revenue, 0); const refunds = orders.reduce((sum, order) => sum + order.refunds, 0); const netRevenue = grossRevenue - refunds;
  return { from, to, currency, orders: orders.length, cancelledOrders: orders.filter((order) => order.cancelledAt).length, grossRevenue, refunds, netRevenue, averageOrderValue: orders.length ? netRevenue / orders.length : 0, projected30DayRevenue: netRevenue / Math.max(1, days) * 30, daily: [...dailyMap.values()], products: [...productMap.values()].sort((a, b) => b.units - a.units) };
}
