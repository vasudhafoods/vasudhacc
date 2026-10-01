import "server-only";
import { shopifyGraphQL } from "@/lib/shopify/client";
import { FULFILLMENT_CREATE_MUTATION, WAREHOUSE_ORDERS_QUERY } from "@/lib/shopify/queries";
import type { ShopifyPageInfo } from "@/types/shopify";
import type { ShopifyWarehouseOrder } from "@/types/warehouse";

interface Money { amount: string; currencyCode: string }
interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  totalPriceSet: { shopMoney: Money };
  customer: { firstName: string | null; lastName: string | null; displayName: string } | null;
  shippingAddress: { name: string | null; address1: string | null; address2: string | null; city: string | null; province: string | null; zip: string | null; country: string | null } | null;
  lineItems: { nodes: { title: string; sku: string | null; quantity: number; currentQuantity: number }[] };
  fulfillmentOrders: { nodes: { id: string; status: string; lineItems: { nodes: { remainingQuantity: number }[] } }[] };
}
interface OrdersResponse { orders: { nodes: ShopifyOrderNode[]; pageInfo: ShopifyPageInfo } }

function mapOrder(order: ShopifyOrderNode): ShopifyWarehouseOrder {
  const address = order.shippingAddress;
  return {
    id: order.id,
    name: order.name,
    createdAt: order.createdAt,
    customerName: order.customer?.displayName || [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ") || address?.name || "Shopify customer",
    destination: [address?.address1, address?.address2, address?.city, address?.province, address?.zip, address?.country].filter(Boolean).join(", "),
    total: order.totalPriceSet.shopMoney.amount,
    currency: order.totalPriceSet.shopMoney.currencyCode,
    fulfillmentOrders: order.fulfillmentOrders.nodes.map((fo) => ({ id: fo.id, status: fo.status, remainingQuantity: fo.lineItems.nodes.reduce((sum, item) => sum + item.remainingQuantity, 0) })).filter((fo) => fo.remainingQuantity > 0 && ["OPEN", "IN_PROGRESS"].includes(fo.status)),
    lines: order.lineItems.nodes.filter((line) => line.currentQuantity > 0).map((line) => ({ title: line.title, sku: line.sku, quantity: line.currentQuantity })),
  };
}

export async function getShopifyWarehouseOrders(): Promise<ShopifyWarehouseOrder[]> {
  const orders: ShopifyWarehouseOrder[] = [];
  let pageInfo: ShopifyPageInfo = { hasNextPage: true, endCursor: null };
  let pages = 0;
  while (pageInfo.hasNextPage && pages++ < 4) {
    const data = await shopifyGraphQL<OrdersResponse>(WAREHOUSE_ORDERS_QUERY, {
      first: 50,
      after: pageInfo.endCursor,
      query: "status:open",
    });
    orders.push(...data.orders.nodes.map(mapOrder).filter((order) => order.fulfillmentOrders.length > 0));
    pageInfo = data.orders.pageInfo;
  }
  return orders;
}

const FULFILLMENT_TARGET_QUERY = `#graphql
  query WarehouseFulfillmentTarget($id: ID!) {
    order(id: $id) {
      id
      name
      fulfillmentOrders(first: 50) {
        nodes { id status lineItems(first: 100) { nodes { remainingQuantity } } }
      }
    }
  }
`;

interface FulfillmentTargetResponse { order: { id: string; name: string; fulfillmentOrders: OrdersResponse["orders"]["nodes"][number]["fulfillmentOrders"] } | null }
interface FulfillmentCreateResponse { fulfillmentCreate: { fulfillment: { id: string; status: string; trackingInfo: { company: string | null; number: string | null; url: string | null }[] } | null } }

export async function fulfillShopifyWarehouseOrder(input: { orderId: string; trackingNumber: string; carrier: string; trackingUrl?: string; notifyCustomer: boolean }) {
  const orderId = input.orderId.trim();
  const trackingNumber = input.trackingNumber.trim();
  const carrier = input.carrier.trim();
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId)) throw new Error("Select a valid Shopify order.");
  if (trackingNumber.length < 2 || trackingNumber.length > 120) throw new Error("Enter a valid tracking number.");
  if (carrier.length < 2 || carrier.length > 100) throw new Error("Enter the delivery partner.");
  const trackingUrl = input.trackingUrl?.trim();
  if (trackingUrl) {
    let parsed: URL;
    try { parsed = new URL(trackingUrl); } catch { throw new Error("Enter a valid tracking URL."); }
    if (parsed.protocol !== "https:") throw new Error("Tracking URL must use HTTPS.");
  }
  const target = await shopifyGraphQL<FulfillmentTargetResponse>(FULFILLMENT_TARGET_QUERY, { id: orderId });
  if (!target.order) throw new Error("Shopify order was not found.");
  const openOrders = target.order.fulfillmentOrders.nodes.filter((fo) => fo.lineItems.nodes.some((line) => line.remainingQuantity > 0) && ["OPEN", "IN_PROGRESS"].includes(fo.status));
  if (!openOrders.length) throw new Error("This order has no remaining items to fulfill.");
  const result = await shopifyGraphQL<FulfillmentCreateResponse>(FULFILLMENT_CREATE_MUTATION, {
    fulfillment: {
      lineItemsByFulfillmentOrder: openOrders.map((fo) => ({ fulfillmentOrderId: fo.id })),
      trackingInfo: { number: trackingNumber, company: carrier, ...(trackingUrl ? { url: trackingUrl } : {}) },
      notifyCustomer: input.notifyCustomer,
    },
  });
  if (!result.fulfillmentCreate.fulfillment) throw new Error("Shopify did not confirm the fulfillment.");
  return { orderName: target.order.name, fulfillment: result.fulfillmentCreate.fulfillment };
}
