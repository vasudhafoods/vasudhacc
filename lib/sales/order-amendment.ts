import { calculateInvoice } from "./invoice-calc";

export type AmendmentLine = { productId: string; quantity: number; unitPricePaisa: number; gstRateBps: number; discountPaisa: number };

export function amendmentTotals(lines: AmendmentLine[]) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 50) throw new Error("Add between 1 and 50 products.");
  const ids = new Set<string>();
  const checked = lines.map(line => {
    if (!line || typeof line.productId !== "string" || !/^[0-9a-f-]{36}$/i.test(line.productId) || ids.has(line.productId)) throw new Error("Choose a unique product for each line.");
    ids.add(line.productId);
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !Number.isSafeInteger(line.unitPricePaisa) || line.unitPricePaisa <= 0) throw new Error("Quantity and unit price must be positive.");
    const subtotal = line.quantity * line.unitPricePaisa;
    if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(line.discountPaisa) || line.discountPaisa < 0 || line.discountPaisa > subtotal) throw new Error("Discount cannot exceed the line value.");
    if (!Number.isSafeInteger(line.gstRateBps) || line.gstRateBps < 0 || line.gstRateBps > 2800) throw new Error("GST must be between 0% and 28%.");
    return line;
  });
  const invoice = calculateInvoice(checked);
  const { subtotalAmountPaisa, discountPaisa, taxPaisa, totalAmountPaisa } = invoice;
  if (!Number.isSafeInteger(subtotalAmountPaisa) || subtotalAmountPaisa > 1_000_000_000 || totalAmountPaisa <= 0) throw new Error("Invoice total must be positive and within the supported limit.");
  const calculated = checked.map((line, index) => {
    const { rateInclusivePaisa, ratePaisa, taxablePaisa, taxPaisa: lineTax, lineTotalPaisa } = invoice.lines[index];
    return { ...line, rateInclusivePaisa, ratePaisa, taxablePaisa, taxPaisa: lineTax, lineTotalPaisa };
  });
  return { lines: calculated, subtotalAmountPaisa, discountPaisa, taxPaisa, totalAmountPaisa };
}

export function reservationAfterCorrection(onHand: number, reserved: number, oldQuantity: number, newQuantity: number) {
  if (reserved < oldQuantity) throw new Error("Reserved stock has changed. Ask Warehouse to reconcile this order.");
  const next = reserved - oldQuantity + newQuantity;
  if (next < 0 || (newQuantity > oldQuantity && next > onHand)) throw new Error("Not enough available Retail stock for the corrected quantity.");
  return next;
}
