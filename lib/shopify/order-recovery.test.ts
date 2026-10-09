import assert from "node:assert/strict";
import test from "node:test";
import { recoveryPayloads, type RecoveryOrder } from "./order-recovery";
import { inventoryWebhookPayload } from "./webhook-payload";

const order: RecoveryOrder = {
  id: "gid://shopify/Order/123", name: "#123", createdAt: "2026-10-09T00:00:00Z", cancelledAt: null, test: false,
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "gid://shopify/LineItem/1", quantity: 3, sku: "FOO22-3", isGiftCard: false, variant: { id: "gid://shopify/ProductVariant/22" } }] },
  fulfillments: [{ fulfillmentLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: 1, lineItem: { id: "gid://shopify/LineItem/1" } }] } }],
  refunds: [{ id: "gid://shopify/Refund/50", refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: 1, restockType: "RETURN", location: { id: "gid://shopify/Location/2" }, lineItem: { id: "gid://shopify/LineItem/1", sku: "FOO22-3", isGiftCard: false, variant: { id: "gid://shopify/ProductVariant/22" } } }] } }],
};
test("recovery uses webhook-compatible IDs, quantities, and fulfilled lines", () => {
  const payload = recoveryPayloads(order);
  assert.equal(payload.order.id, "123");
  assert.equal(payload.order.line_items[0].variant_id, "22");
  assert.equal(payload.order.line_items[0].quantity, 3);
  assert.deepEqual(payload.order.fulfillments[0].line_items, [{ id: "1", quantity: 1 }]);
  assert.equal(payload.refunds[0].refund_line_items[0].restock_type, "return");
  assert.equal(payload.refunds[0].order_id, "123");
});
test("truncated orders never partially reduce stock", () => {
  assert.throws(() => recoveryPayloads({ ...order, lineItems: { ...order.lineItems, pageInfo: { hasNextPage: true } } }), /no partial order/);
});
test("retry payloads retain inventory data without customer or payment data", () => {
  const payload = { ...recoveryPayloads(order).order, customer: { email: "private@example.com" }, shipping_address: { address1: "Private" }, payment_details: { private: true } };
  const saved = inventoryWebhookPayload(payload);
  assert.equal(saved.customer, undefined);
  assert.equal(saved.shipping_address, undefined);
  assert.equal(saved.payment_details, undefined);
  assert.deepEqual(saved.line_items, payload.line_items);
  assert.deepEqual(saved.fulfillments, payload.fulfillments);
});
