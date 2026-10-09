export const ORDER_RECOVERY_QUERY = `#graphql
  query InventoryOrderRecovery($after: String, $query: String!) {
    orders(first: 25, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt cancelledAt test
        lineItems(first: 250) {
          pageInfo { hasNextPage }
          nodes { id quantity sku isGiftCard variant { id } }
        }
        fulfillments {
          fulfillmentLineItems(first: 250) {
            pageInfo { hasNextPage }
            nodes { quantity lineItem { id } }
          }
        }
        refunds {
          id
          refundLineItems(first: 250) {
            pageInfo { hasNextPage }
            nodes { quantity restockType location { id } lineItem { id sku isGiftCard variant { id } } }
          }
        }
      }
    }
  }
`;

type Line = { id: string; quantity?: number; sku: string | null; isGiftCard: boolean; variant: { id: string } | null };
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } };
export type RecoveryOrder = {
  id: string; name: string; createdAt: string; cancelledAt: string | null; test: boolean;
  lineItems: Connection<Line>;
  fulfillments: { fulfillmentLineItems: Connection<{ quantity: number; lineItem: { id: string } }> }[];
  refunds: { id: string; refundLineItems: Connection<{ quantity: number; restockType: string; location: { id: string } | null; lineItem: Line }> }[];
};
export function numericId(id: string) { return id.split("/").at(-1)!; }
export function recoveryPayloads(order: RecoveryOrder) {
  if (order.lineItems.pageInfo.hasNextPage || order.fulfillments.some(row => row.fulfillmentLineItems.pageInfo.hasNextPage) || order.refunds.some(row => row.refundLineItems.pageInfo.hasNextPage)) throw new Error(`Order ${order.name} exceeds recovery line limits; no partial order was applied.`);
  const line = (row: Line) => ({ id: numericId(row.id), variant_id: row.variant ? numericId(row.variant.id) : null, quantity: row.quantity, sku: row.sku, gift_card: row.isGiftCard });
  return {
    order: { id: numericId(order.id), test: order.test, line_items: order.lineItems.nodes.map(line), fulfillments: order.fulfillments.map(row => ({ line_items: row.fulfillmentLineItems.nodes.map(item => ({ id: numericId(item.lineItem.id), quantity: item.quantity })) })) },
    refunds: order.refunds.map(refund => ({ id: numericId(refund.id), order_id: numericId(order.id), refund_line_items: refund.refundLineItems.nodes.map(row => ({ quantity: row.quantity, restock_type: row.restockType.toLowerCase(), location_id: row.location ? numericId(row.location.id) : null, line_item: line(row.lineItem) })) })),
  };
}
