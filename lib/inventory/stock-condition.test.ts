import assert from "node:assert/strict";
import test from "node:test";
import { bucketAvailable, isConditionTransfer } from "./stock-condition";
import type { WarehouseBucketBalance } from "@/types/warehouse";

test("warehouse can quarantine saleable stock and inspect or reject QC stock", () => {
  for (const source of ["online", "retail", "buffer"]) {
    for (const target of ["qc", "damaged"]) assert.equal(isConditionTransfer(source, target), true);
  }
  assert.equal(isConditionTransfer("qc", "damaged"), true);
  assert.equal(isConditionTransfer("qc", "buffer"), true);
  assert.equal(isConditionTransfer("damaged", "qc"), true);
});

test("damaged stock cannot bypass inspection and transfers stay within the warehouse condition workflow", () => {
  for (const [source, target] of [["damaged", "online"], ["damaged", "retail"], ["damaged", "buffer"], ["qc", "qc"], ["buffer", "retail"], ["invalid", "qc"], ["toString", "qc"], [null, "qc"], ["qc", null]]) {
    assert.equal(isConditionTransfer(source, target), false);
  }
});

test("missing buckets show zero and reserved or other warehouse stock cannot be used", () => {
  const balances: WarehouseBucketBalance[] = [
    { productId: "p", warehouseLocationId: "a", bucket: "damaged", onHand: 8, reserved: 3, available: 8 },
    { productId: "p", warehouseLocationId: "b", bucket: "qc", onHand: 20, reserved: 0, available: 20 },
  ];
  assert.equal(bucketAvailable(balances, "p", "a", "damaged"), 5);
  assert.equal(bucketAvailable(balances, "p", "a", "qc"), 0);
  assert.equal(bucketAvailable(balances, "other", "a", "damaged"), 0);
  assert.equal(bucketAvailable([{ ...balances[0], reserved: 10 }], "p", "a", "damaged"), 0);
});
