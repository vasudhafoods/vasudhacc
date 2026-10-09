// Persist only inventory fields, never customer addresses or payment information.
export function inventoryWebhookPayload(input: unknown): Record<string, unknown> {
  const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const pick = (value: unknown, keys: string[]) => {
    const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  };
  const lines = (value: unknown) => Array.isArray(value) ? value.map(line => pick(line, ["id", "variant_id", "quantity", "sku", "gift_card"])) : [];
  return {
    ...pick(row, ["id", "order_id", "location_id", "test"]),
    line_items: lines(row.line_items),
    fulfillments: Array.isArray(row.fulfillments) ? row.fulfillments.map(value => ({ line_items: lines((value as Record<string, unknown>).line_items) })) : [],
    refund_line_items: Array.isArray(row.refund_line_items) ? row.refund_line_items.map(value => ({
      ...pick(value, ["quantity", "location_id", "restock_type"]),
      line_item: pick((value as Record<string, unknown>).line_item, ["id", "variant_id", "quantity", "sku", "gift_card"]),
    })) : [],
  };
}
