export function discountPercent(subtotalPaisa: number, discountPaisa: number): string {
  return subtotalPaisa > 0 ? String(discountPaisa / subtotalPaisa * 100) : "0";
}

export function discountFromPercent(subtotalPaisa: number, percent: string): number {
  const value = Number(percent);
  if (!percent.trim() || !Number.isFinite(value) || value < 0 || value > 100) throw new Error("Discount must be between 0% and 100%.");
  return Math.round(subtotalPaisa * value / 100);
}
