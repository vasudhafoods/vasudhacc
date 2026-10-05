// Accounts-style (Tally) invoice maths. Unit prices are GST-inclusive list prices:
// discounted inclusive rate -> rate excl. GST (2 dp) -> amount = qty x rate,
// CGST/SGST (or IGST for inter-state supply) per GST slab on the summed taxable value,
// then round off to the rupee.
export type InvoiceLineInput = { quantity: number; unitPricePaisa: number; gstRateBps: number; discountPaisa: number };

export type InvoiceLineResult = {
  /** Total discount on the line, including its share of the extra invoice discount. */
  discountPaisa: number;
  rateInclusivePaisa: number;
  ratePaisa: number;
  taxablePaisa: number;
  taxPaisa: number;
  lineTotalPaisa: number;
};

export type InvoiceTaxSlab = { gstRateBps: number; taxablePaisa: number; cgstPaisa: number; sgstPaisa: number; igstPaisa: number };

export type InvoiceTotals = {
  lines: InvoiceLineResult[];
  slabs: InvoiceTaxSlab[];
  subtotalAmountPaisa: number;
  productDiscountPaisa: number;
  invoiceDiscountPaisa: number;
  discountPaisa: number;
  taxablePaisa: number;
  cgstPaisa: number;
  sgstPaisa: number;
  igstPaisa: number;
  taxPaisa: number;
  roundOffPaisa: number;
  totalAmountPaisa: number;
};

const exclusive = (inclusivePaisa: number, gstRateBps: number) => Math.round(inclusivePaisa * 10_000 / (10_000 + gstRateBps));

/** Splits an amount across weights by largest remainder so the shares add up exactly. */
function allocate(amount: number, weights: number[]) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!amount || !total) return weights.map(() => 0);
  const shares = weights.map(weight => Math.floor(amount * weight / total));
  let remaining = amount - shares.reduce((sum, share) => sum + share, 0);
  const order = weights.map((weight, index) => ({ index, remainder: (amount * weight) % total })).sort((left, right) => right.remainder - left.remainder);
  for (const item of order) {
    if (remaining <= 0) break;
    if (shares[item.index] < weights[item.index]) { shares[item.index] += 1; remaining -= 1; }
  }
  return shares;
}

/** Inputs must already be validated as safe non-negative integers with discount <= line value. */
export function calculateInvoice(lines: InvoiceLineInput[], additionalDiscountPaisa = 0, options: { interState?: boolean } = {}): InvoiceTotals {
  const gross = lines.map(line => line.quantity * line.unitPricePaisa);
  const afterProductDiscount = lines.map((line, index) => Math.max(0, gross[index] - line.discountPaisa));
  const productDiscountPaisa = lines.reduce((sum, line, index) => sum + gross[index] - afterProductDiscount[index], 0);
  const invoiceDiscountPaisa = Math.min(Math.max(0, additionalDiscountPaisa), afterProductDiscount.reduce((sum, value) => sum + value, 0));
  const shares = allocate(invoiceDiscountPaisa, afterProductDiscount);

  const slabMap = new Map<number, number>();
  const calculated = lines.map((line, index) => {
    const rateInclusivePaisa = line.quantity > 0 ? Math.round(afterProductDiscount[index] / line.quantity) : 0;
    const ratePaisa = exclusive(rateInclusivePaisa, line.gstRateBps);
    // The extra invoice discount is entered GST-inclusive; it reduces the taxable value net of GST.
    const taxablePaisa = Math.max(0, line.quantity * ratePaisa - exclusive(shares[index], line.gstRateBps));
    const taxPaisa = Math.round(taxablePaisa * line.gstRateBps / 10_000);
    slabMap.set(line.gstRateBps, (slabMap.get(line.gstRateBps) ?? 0) + taxablePaisa);
    return { discountPaisa: gross[index] - afterProductDiscount[index] + shares[index], rateInclusivePaisa, ratePaisa, taxablePaisa, taxPaisa, lineTotalPaisa: taxablePaisa + taxPaisa };
  });

  const slabs = [...slabMap].sort(([left], [right]) => left - right).map(([gstRateBps, taxablePaisa]) => {
    if (options.interState) return { gstRateBps, taxablePaisa, cgstPaisa: 0, sgstPaisa: 0, igstPaisa: Math.round(taxablePaisa * gstRateBps / 10_000) };
    const half = Math.round(taxablePaisa * gstRateBps / 20_000);
    return { gstRateBps, taxablePaisa, cgstPaisa: half, sgstPaisa: half, igstPaisa: 0 };
  });
  const taxablePaisa = slabs.reduce((sum, slab) => sum + slab.taxablePaisa, 0);
  const cgstPaisa = slabs.reduce((sum, slab) => sum + slab.cgstPaisa, 0);
  const sgstPaisa = slabs.reduce((sum, slab) => sum + slab.sgstPaisa, 0);
  const igstPaisa = slabs.reduce((sum, slab) => sum + slab.igstPaisa, 0);
  const taxPaisa = cgstPaisa + sgstPaisa + igstPaisa;
  const beforeRoundOff = taxablePaisa + taxPaisa;
  const totalAmountPaisa = Math.round(beforeRoundOff / 100) * 100;
  const subtotalAmountPaisa = gross.reduce((sum, value) => sum + value, 0);
  return {
    lines: calculated, slabs, subtotalAmountPaisa, productDiscountPaisa, invoiceDiscountPaisa,
    discountPaisa: productDiscountPaisa + invoiceDiscountPaisa,
    taxablePaisa, cgstPaisa, sgstPaisa, igstPaisa, taxPaisa,
    roundOffPaisa: totalAmountPaisa - beforeRoundOff, totalAmountPaisa,
  };
}
