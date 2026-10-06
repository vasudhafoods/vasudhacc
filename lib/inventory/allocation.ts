// Shopify is opt-in per receipt: 40/40/20 when checked, otherwise all usable stock to Retail.
export function receiptAllocation(usableQuantity: number, onShopify: boolean) {
  const online = onShopify ? Math.round(usableQuantity * 0.4) : 0;
  const retail = Math.round(usableQuantity * (onShopify ? 0.4 : 1));
  return { online, retail, buffer: usableQuantity - online - retail };
}
