// How received usable stock is split. Products listed on Shopify: 40% Shopify, 40% Retail, 20% Buffer.
// Retail-only products (no Shopify listing, e.g. chikkis): nothing to Shopify, 80% Retail, 20% Buffer.
// Whole packets are rounded, with any remainder assigned to Buffer.
export function receiptAllocation(usableQuantity: number, onShopify: boolean) {
  const online = onShopify ? Math.round(usableQuantity * 0.4) : 0;
  const retail = Math.round(usableQuantity * (onShopify ? 0.4 : 0.8));
  return { online, retail, buffer: usableQuantity - online - retail };
}
