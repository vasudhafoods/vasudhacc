import assert from "node:assert/strict";
import test from "node:test";
import { calculateInvoice } from "./invoice-calc";

const line = (quantity: number, unitPricePaisa: number, discountPercent: number, gstRateBps = 500) =>
  ({ quantity, unitPricePaisa, gstRateBps, discountPaisa: Math.round(quantity * unitPricePaisa * discountPercent / 100) });

test("matches the accounts team's Tally invoice", () => {
  const result = calculateInvoice([line(12, 12000, 30), line(12, 12000, 30), line(13, 12000, 30), line(13, 12000, 30), line(100, 1000, 26.5)]);
  assert.deepEqual(result.lines.map(item => [item.rateInclusivePaisa, item.ratePaisa, item.taxablePaisa]), [
    [8400, 8000, 96000], [8400, 8000, 96000], [8400, 8000, 104000], [8400, 8000, 104000], [735, 700, 70000],
  ]);
  assert.equal(result.taxablePaisa, 470000);
  assert.equal(result.cgstPaisa, 11750);
  assert.equal(result.sgstPaisa, 11750);
  assert.equal(result.roundOffPaisa, 0);
  assert.equal(result.totalAmountPaisa, 493500);
});

test("rounds the grand total to the nearest rupee", () => {
  const result = calculateInvoice([{ quantity: 3, unitPricePaisa: 9900, gstRateBps: 500, discountPaisa: 700 }]);
  assert.equal(result.lines[0].rateInclusivePaisa, 9667);
  assert.equal(result.lines[0].ratePaisa, 9207);
  assert.equal(result.taxablePaisa, 27621);
  assert.equal(result.taxPaisa, 1382);
  assert.equal(result.roundOffPaisa, -3);
  assert.equal(result.totalAmountPaisa, 29000);
});

test("extra invoice discount reduces taxable value net of GST", () => {
  const result = calculateInvoice([line(10, 10500, 0)], 1050);
  assert.equal(result.invoiceDiscountPaisa, 1050);
  assert.equal(result.lines[0].discountPaisa, 1050);
  assert.equal(result.taxablePaisa, 99000);
  assert.equal(result.totalAmountPaisa, 104000);
});

test("separate GST slabs are taxed separately", () => {
  const result = calculateInvoice([line(1, 11200, 0, 1200), line(1, 10500, 0, 500)]);
  assert.deepEqual(result.slabs.map(slab => [slab.gstRateBps, slab.taxablePaisa, slab.cgstPaisa]), [[500, 10000, 250], [1200, 10000, 600]]);
  assert.equal(result.totalAmountPaisa, 21700);
});
