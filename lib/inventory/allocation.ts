// Every usable physical packet is allocated across Online, Retail, and Buffer.
export function receiptAllocation(usableQuantity: number) {
  const online = Math.round(usableQuantity * 0.4);
  const retail = Math.round(usableQuantity * 0.4);
  return { online, retail, buffer: usableQuantity - online - retail };
}
