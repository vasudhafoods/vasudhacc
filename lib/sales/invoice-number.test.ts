import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInvoiceNumber } from "./invoice-number";

test("NA placeholders are missing invoice numbers, including mixed case and whitespace", () => {
  for (const value of ["NA", "na", " Na ", ""]) assert.equal(normalizeInvoiceNumber(value), null);
});

test("actual invoice numbers retain their identity", () => {
  for (const value of ["NA-100", "INV/2026/10"]) assert.equal(normalizeInvoiceNumber(` ${value} `), value);
});
