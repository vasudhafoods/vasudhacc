import assert from "node:assert/strict";
import test from "node:test";
import { discountPercent, discountFromPercent } from "./discount-percent";

test("percentage discount follows edited quantity and price", () => {
  assert.equal(discountFromPercent(20000, "10"), 2000);
  assert.equal(discountFromPercent(30000, "10"), 3000);
  assert.equal(discountFromPercent(9990, "12.5"), 1249);
});
test("opening and saving existing discounts preserves every paisa", () => {
  for (const subtotal of [99, 9900, 29700, 999999999]) {
    for (const amount of [0, 1, Math.floor(subtotal / 3), subtotal]) {
      assert.equal(discountFromPercent(subtotal, discountPercent(subtotal, amount)), amount);
    }
  }
});
test("rejects invalid percentages", () => {
  for (const percent of ["", "-1", "101", "NaN", "Infinity"]) assert.throws(() => discountFromPercent(10000, percent));
});
