import assert from "node:assert/strict";
import test from "node:test";
import { amendmentTotals, reservationAfterCorrection } from "./order-amendment";

const line = { productId: "11111111-1111-4111-8111-111111111111", quantity: 3, unitPricePaisa: 9900, gstRateBps: 500, discountPaisa: 700 };
test("corrections use accounts-style GST totals and keep discounts", () => {
  const result = amendmentTotals([line]);
  assert.equal(result.subtotalAmountPaisa, 29700);
  assert.equal(result.discountPaisa, 700);
  assert.equal(result.totalAmountPaisa, 29000);
  assert.equal(result.taxPaisa, 1382);
  assert.equal(result.lines[0].taxablePaisa, 27621);
});
test("invalid or duplicate lines cannot change an invoice", () => {
  for (const lines of [[], [line, line], [{ ...line, quantity: -1 }], [{ ...line, quantity: 1.5 }], [{ ...line, discountPaisa: 30000 }], [{ ...line, gstRateBps: 2900 }], [{ ...line, unitPricePaisa: Infinity }], [{ ...line, discountPaisa: 29700 }]]) {
    assert.throws(() => amendmentTotals(lines));
  }
});
test("invoice amounts are bounded", () => {
  assert.throws(() => amendmentTotals([{ ...line, quantity: 1000000 }]));
});
test("editing uses the existing reservation as available stock", () => {
  assert.equal(reservationAfterCorrection(20, 15, 10, 15), 20);
  assert.equal(reservationAfterCorrection(20, 15, 10, 3), 8);
});
test("cancellation releases only this order's reservation", () => {
  assert.equal(reservationAfterCorrection(20, 15, 10, 0), 5);
});
test("correction cannot consume stock reserved for other orders", () => {
  assert.throws(() => reservationAfterCorrection(20, 15, 10, 16));
});
test("missing reservations fail instead of releasing another order's stock", () => {
  assert.throws(() => reservationAfterCorrection(20, 5, 10, 0));
});
test("a stock discrepancy still permits reducing a valid reservation", () => {
  assert.equal(reservationAfterCorrection(5, 15, 10, 5), 10);
});
