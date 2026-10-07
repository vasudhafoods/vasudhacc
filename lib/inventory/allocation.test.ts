import assert from "node:assert/strict";
import test from "node:test";
import { receiptAllocation } from "./allocation";

test("received products split 40% Online, 40% Retail, and the remainder to Buffer", () => {
  assert.deepEqual(receiptAllocation(100), { online: 40, retail: 40, buffer: 20 });
  assert.deepEqual(receiptAllocation(7), { online: 3, retail: 3, buffer: 1 });
});

test("zero usable units allocate zero stock", () => {
  assert.deepEqual(receiptAllocation(0), { online: 0, retail: 0, buffer: 0 });
});

test("every whole-packet allocation conserves usable stock", () => {
  for (let quantity = 0; quantity <= 1000; quantity++) {
    const split = receiptAllocation(quantity);
    assert.equal(split.online + split.retail + split.buffer, quantity);
    assert.ok(Object.values(split).every(value => Number.isInteger(value) && value >= 0));
  }
});
