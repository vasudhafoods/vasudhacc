import assert from "node:assert/strict";
import test from "node:test";
import { receiptAllocation } from "./allocation";

test("Shopify products split 40% Shopify, 40% Retail, 20% Buffer", () => {
  assert.deepEqual(receiptAllocation(100, true), { online: 40, retail: 40, buffer: 20 });
  assert.deepEqual(receiptAllocation(7, true), { online: 3, retail: 3, buffer: 1 });
});

test("retail-only products send nothing to Shopify", () => {
  assert.deepEqual(receiptAllocation(100, false), { online: 0, retail: 100, buffer: 0 });
  assert.deepEqual(receiptAllocation(7, false), { online: 0, retail: 7, buffer: 0 });
  assert.deepEqual(receiptAllocation(0, false), { online: 0, retail: 0, buffer: 0 });
});

test("every whole-packet allocation conserves usable stock", () => {
  for (let quantity = 0; quantity <= 1000; quantity++) for (const enabled of [true, false]) {
    const split = receiptAllocation(quantity, enabled);
    assert.equal(split.online + split.retail + split.buffer, quantity);
    assert.ok(Object.values(split).every(value => Number.isInteger(value) && value >= 0));
  }
});
