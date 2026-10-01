import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { randomUUID as uuid } from "node:crypto";
import { auditEvents, inventoryBalances, inventoryTransactionLines, inventoryTransactions, offlineSaleCollections, offlineSales, products, salesCustomers, warehouseLocations } from "@/db/schema";
import { fetchShopifyPricesBySku } from "@/services/shopify-inventory";
import { listedOfflineUnitPricePaisa } from "@/lib/offline-product-pricing";
import type { OfflineCustomerType, OfflinePaymentStatus, OfflineSaleRow, OfflineSalesEntryData, OfflineSalesOverview, SalesCustomer } from "@/types/offline-sales";

const MAX_AMOUNT_PAISA = 1_000_000_000;

export class OfflineSalesError extends Error {
  constructor(readonly code: "INVALID_SALE" | "INVALID_COLLECTION" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "OfflineSalesError";
  }
}

function text(value: string | undefined, label: string, min: number, max: number, required = false): string | null {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  if (!cleaned && !required) return null;
  if (cleaned.length < min || cleaned.length > max) throw new OfflineSalesError("INVALID_SALE", `${label} must be between ${min} and ${max} characters.`);
  return cleaned;
}

function validPaisa(value: number, code: "INVALID_SALE" | "INVALID_COLLECTION", label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT_PAISA) throw new OfflineSalesError(code, `${label} must be a valid positive amount.`);
  return value;
}

function saleDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OfflineSalesError("INVALID_SALE", "A valid sale date is required.");
  const date = new Date(`${value}T12:00:00+05:30`);
  if (Number.isNaN(date.getTime())) throw new OfflineSalesError("INVALID_SALE", "A valid sale date is required.");
  return date;
}

function paymentStatus(totalAmountPaisa: number, collectedAmountPaisa: number): OfflinePaymentStatus {
  if (collectedAmountPaisa <= 0) return "pending";
  return collectedAmountPaisa >= totalAmountPaisa ? "paid" : "partial";
}

function toRow(sale: typeof offlineSales.$inferSelect, collectedAmountPaisa: number): OfflineSaleRow {
  const collected = Math.min(sale.totalAmountPaisa, Math.max(0, collectedAmountPaisa));
  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    saleDate: sale.saleDate.toISOString(),
    customerName: sale.customerName,
    customerCompanyName: sale.customerCompanyName,
    customerContact: sale.customerContact,
    billingInvoiceNumber: sale.billingInvoiceNumber,
    billingAddress: sale.billingAddress,
    shippingAddress: sale.shippingAddress,
    shippingSameAsBilling: sale.shippingSameAsBilling,
    gstNumber: sale.gstNumber,
    customerType: sale.customerType as OfflineCustomerType,
    isNewB2bCustomer: sale.isNewB2bCustomer,
    totalAmountPaisa: sale.totalAmountPaisa,
    subtotalAmountPaisa: sale.subtotalAmountPaisa,
    discountPaisa: sale.discountPaisa,
    taxPaisa: sale.taxPaisa,
    collectedAmountPaisa: collected,
    pendingAmountPaisa: sale.totalAmountPaisa - collected,
    paymentStatus: paymentStatus(sale.totalAmountPaisa, collected),
    reference: sale.reference,
    notes: sale.notes,
    orderType: sale.orderType,
    location: sale.location,
    deliveryStatus: sale.deliveryStatus,
    deliveryPartner: sale.deliveryPartner,
    deliveryCostPaisa: sale.deliveryCostPaisa,
    lrNumber: sale.lrNumber,
    warehouseLocationId: sale.warehouseLocationId,
    expectedNextPaymentDate: sale.expectedNextPaymentDate,
    lines: sale.lines,
    createdBy: sale.createdBy,
  };
}

export async function getOfflineSalesEntryData(): Promise<OfflineSalesEntryData> {
  const db = getDatabase();
  const [productsRows, locations, retailRows, livePrices, customers] = await Promise.all([
    db.select({ id: products.id, sku: products.sku, name: products.name, category: products.category, unitPricePaisa: products.unitPricePaisa }).from(products).where(eq(products.active, true)).orderBy(products.name),
    db.select({ id: warehouseLocations.id, code: warehouseLocations.code, name: warehouseLocations.name }).from(warehouseLocations).where(eq(warehouseLocations.active, true)).orderBy(warehouseLocations.name),
    db.select({ productId: inventoryBalances.productId, warehouseLocationId: inventoryBalances.warehouseLocationId, onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved }).from(inventoryBalances).where(eq(inventoryBalances.bucket, "retail")),
    fetchShopifyPricesBySku().catch(() => new Map<string, number>()),
    db.select({ id: salesCustomers.id, name: salesCustomers.name, companyName: salesCustomers.companyName, address: salesCustomers.address, phone: salesCustomers.phone, gstNumber: salesCustomers.gstNumber }).from(salesCustomers).where(eq(salesCustomers.active, true)).orderBy(salesCustomers.name),
  ]);
  return {
    products: productsRows.flatMap((product) => {
      if (/\b(combo|bundle|variety|bestsellers?|medley|box|delights|assorted)\b/i.test(product.name)) return [];
      const packMatch = product.name.match(/\bpack\s+of\s+(\d+)\b/i);
      if (packMatch && Number(packMatch[1]) !== 1) return [];
      const displayName = product.name.replace(/\s*[·|–—-]\s*pack\s+of\s+1\b.*$/i, "").trim() || product.name;
      return [{ ...product, name: displayName, unitPricePaisa: listedOfflineUnitPricePaisa(displayName) ?? livePrices.get(product.sku.trim().toUpperCase()) ?? product.unitPricePaisa }];
    }),
    locations,
    retailBalances: retailRows.map((row) => ({ productId: row.productId, warehouseLocationId: row.warehouseLocationId, available: Math.max(0, row.onHand - row.reserved) })),
    customers,
  };
}

export async function createSalesCustomer(input: { name: string; companyName?: string; address: string; phone: string; gstNumber?: string; actorUsername: string }): Promise<SalesCustomer> {
  const name = text(input.name, "Customer name", 2, 160, true)!;
  const companyName = text(input.companyName, "Company name", 2, 160);
  const address = text(input.address, "Customer address", 5, 500, true)!;
  const phone = text(input.phone, "Phone number", 7, 20, true)!;
  if (!/^\+?[0-9 ().-]{7,20}$/.test(phone)) throw new OfflineSalesError("INVALID_SALE", "Enter a valid customer phone number.");
  const gstNumber = text(input.gstNumber, "GST number", 15, 15)?.toUpperCase() ?? null;
  if (gstNumber && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstNumber)) throw new OfflineSalesError("INVALID_SALE", "Enter a valid GSTIN or leave it blank.");
  const db = getDatabase();
  const [customer] = await db.insert(salesCustomers).values({ name, companyName, address, phone, gstNumber, createdBy: input.actorUsername }).returning({ id: salesCustomers.id, name: salesCustomers.name, companyName: salesCustomers.companyName, address: salesCustomers.address, phone: salesCustomers.phone, gstNumber: salesCustomers.gstNumber });
  await db.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "sales_customer.created", entityType: "sales_customer", entityId: customer.id, newValue: customer, reason: "Sales customer added for repeat order entry" });
  return customer;
}

function rangeBoundary(value: string, boundary: "start" | "end"): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OfflineSalesError("INVALID_SALE", "A valid reporting date range is required.");
  return new Date(`${value}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}+05:30`);
}

function mapCollections(rows: { offlineSaleId: string; amountPaisa: number }[]): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const row of rows) amounts.set(row.offlineSaleId, (amounts.get(row.offlineSaleId) ?? 0) + row.amountPaisa);
  return amounts;
}

export async function getOfflineSalesOverview(range: { from: string; to: string }): Promise<OfflineSalesOverview> {
  const from = rangeBoundary(range.from, "start");
  const to = rangeBoundary(range.to, "end");
  if (from > to) throw new OfflineSalesError("INVALID_SALE", "The reporting start date must be before the end date.");
  const db = getDatabase();
  const [allSales, allCollections, periodSales, periodCollections] = await Promise.all([
    db.select().from(offlineSales),
    db.select({ offlineSaleId: offlineSaleCollections.offlineSaleId, amountPaisa: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections),
    db.select().from(offlineSales).where(and(gte(offlineSales.saleDate, from), lte(offlineSales.saleDate, to))).orderBy(desc(offlineSales.saleDate)),
    db.select({ amountPaisa: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections).where(and(gte(offlineSaleCollections.collectedAt, from), lte(offlineSaleCollections.collectedAt, to))),
  ]);
  const collectionsBySale = mapCollections(allCollections);
  const allRows = allSales.map((sale) => toRow(sale, collectionsBySale.get(sale.id) ?? 0));
  const periodRows = periodSales.map((sale) => toRow(sale, collectionsBySale.get(sale.id) ?? 0));
  const salesAmountPaisa = periodRows.reduce((sum, sale) => sum + sale.totalAmountPaisa, 0);
  const collectedAmountPaisa = periodCollections.reduce((sum, collection) => sum + collection.amountPaisa, 0);
  const outstandingSales = allRows.filter((sale) => sale.pendingAmountPaisa > 0).sort((left, right) => right.pendingAmountPaisa - left.pendingAmountPaisa || right.saleDate.localeCompare(left.saleDate));
  return {
    salesAmountPaisa,
    collectedAmountPaisa,
    openReceivablesPaisa: outstandingSales.reduce((sum, sale) => sum + sale.pendingAmountPaisa, 0),
    newB2bCustomers: periodRows.filter((sale) => sale.customerType === "b2b" && sale.isNewB2bCustomer).length,
    salesCount: periodRows.length,
    recentSales: periodRows.slice(0, 20),
    outstandingSales: outstandingSales.slice(0, 12),
  };
}

export async function createOfflineSale(input: {
  saleDate: string;
  billingInvoiceNumber: string;
  customerName: string;
  customerCompanyName?: string;
  customerContact?: string;
  billingAddress: string;
  shippingAddress?: string;
  shippingSameAsBilling: boolean;
  gstNumber?: string;
  customerType: OfflineCustomerType;
  isNewB2bCustomer: boolean;
  initialCollectionPaisa: number;
  additionalDiscountPaisa?: number;
  paymentMode?: string;
  paymentTransactionId?: string;
  paymentReceiverName?: string;
  paymentProofFileName?: string;
  invoiceFileName: string;
  expectedNextPaymentDate?: string;
  warehouseLocationId: string;
  reference?: string;
  notes?: string;
  orderType?: string;
  location?: string;
  deliveryStatus?: string;
  deliveryPartner?: string;
  deliveryCostPaisa?: number;
  lrNumber?: string;
  lines: { productId: string; productName: string; sku: string; quantity: number; unitPricePaisa: number; gstRateBps: number; discountPaisa: number }[];
  actorUsername: string;
  idempotencyKey: string;
}): Promise<{ sale: OfflineSaleRow; duplicate: boolean }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new OfflineSalesError("INVALID_SALE", "A valid submission key is required. Please try again.");
  const date = saleDate(input.saleDate);
  const billingInvoiceNumber = text(input.billingInvoiceNumber, "Billing invoice number", 2, 100, true)!;
  if (!input.invoiceFileName?.trim()) throw new OfflineSalesError("INVALID_SALE", "Upload the invoice copy before submitting the order.");
  const customerName = text(input.customerName, "Customer name", 2, 160, true)!;
  const customerCompanyName = text(input.customerCompanyName, "Company name", 2, 160);
  const customerContact = text(input.customerContact, "Customer contact", 3, 80);
  const billingAddress = text(input.billingAddress, "Billing address", 5, 500, true)!;
  const shippingSameAsBilling = Boolean(input.shippingSameAsBilling);
  const shippingAddress = shippingSameAsBilling ? billingAddress : text(input.shippingAddress, "Shipping address", 5, 500, true)!;
  const gstNumber = text(input.gstNumber, "GST number", 15, 15);
  if (gstNumber && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstNumber.toUpperCase())) throw new OfflineSalesError("INVALID_SALE", "Enter a valid GSTIN or leave it blank for an unregistered customer.");
  const reference = text(input.reference, "Invoice / reference", 2, 120);
  const notes = text(input.notes, "Notes", 2, 1_000);
  if (input.customerType !== "retail" && input.customerType !== "b2b") throw new OfflineSalesError("INVALID_SALE", "Select Retail or B2B customer.");
  if (!input.warehouseLocationId) throw new OfflineSalesError("INVALID_SALE", "Select the warehouse that will prepare this order.");
  const uniqueProducts = new Set<string>();
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) throw new OfflineSalesError("INVALID_SALE", "Add between 1 and 50 order product lines.");
  let subtotalAmountPaisa = 0;
  let productDiscountPaisa = 0;
  const baseLines = input.lines.map((line) => {
    if (!line.productId || !line.productName.trim() || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !Number.isSafeInteger(line.unitPricePaisa) || line.unitPricePaisa <= 0) throw new OfflineSalesError("INVALID_SALE", "Each product needs a valid item, quantity, and unit price.");
    if (!Number.isSafeInteger(line.gstRateBps) || line.gstRateBps < 0 || line.gstRateBps > 2800) throw new OfflineSalesError("INVALID_SALE", "GST must be from 0% to 28%.");
    const lineSubtotal = line.quantity * line.unitPricePaisa;
    if (!Number.isSafeInteger(lineSubtotal) || !Number.isSafeInteger(line.discountPaisa) || line.discountPaisa < 0 || line.discountPaisa > lineSubtotal) throw new OfflineSalesError("INVALID_SALE", "A line discount cannot exceed the product line value.");
    if (uniqueProducts.has(line.productId)) throw new OfflineSalesError("INVALID_SALE", "Each product can appear only once; combine quantities on its line.");
    uniqueProducts.add(line.productId);
    subtotalAmountPaisa += lineSubtotal;
    productDiscountPaisa += line.discountPaisa;
    return { ...line, lineSubtotal, taxableBeforeInvoiceDiscount: lineSubtotal - line.discountPaisa };
  });
  const taxableBeforeInvoiceDiscount = subtotalAmountPaisa - productDiscountPaisa;
  const invoiceDiscountPaisa = input.additionalDiscountPaisa ?? 0;
  if (!Number.isSafeInteger(invoiceDiscountPaisa) || invoiceDiscountPaisa < 0 || invoiceDiscountPaisa > taxableBeforeInvoiceDiscount) throw new OfflineSalesError("INVALID_SALE", "Extra invoice discount cannot exceed the remaining invoice value.");
  const allocations = baseLines.map((line) => taxableBeforeInvoiceDiscount ? Math.floor(invoiceDiscountPaisa * line.taxableBeforeInvoiceDiscount / taxableBeforeInvoiceDiscount) : 0);
  let unallocatedDiscount = invoiceDiscountPaisa - allocations.reduce((sum, amount) => sum + amount, 0);
  const allocationOrder = baseLines.map((line, index) => ({ index, remainder: taxableBeforeInvoiceDiscount ? (invoiceDiscountPaisa * line.taxableBeforeInvoiceDiscount) % taxableBeforeInvoiceDiscount : 0 })).sort((left, right) => right.remainder - left.remainder);
  for (const item of allocationOrder) {
    if (unallocatedDiscount <= 0) break;
    if (allocations[item.index] < baseLines[item.index].taxableBeforeInvoiceDiscount) { allocations[item.index] += 1; unallocatedDiscount -= 1; }
  }
  let taxPaisa = 0;
  const lines = baseLines.map((line, index) => {
    const allocatedDiscount = allocations[index];
    const totalLineDiscount = line.discountPaisa + allocatedDiscount;
    const lineTaxPaisa = Math.round((line.lineSubtotal - totalLineDiscount) * line.gstRateBps / 10_000);
    const lineTotalPaisa = line.lineSubtotal - totalLineDiscount + lineTaxPaisa;
    taxPaisa += lineTaxPaisa;
    return { productId: line.productId, productName: line.productName, sku: line.sku, quantity: line.quantity, unitPricePaisa: line.unitPricePaisa, gstRateBps: line.gstRateBps, discountPaisa: totalLineDiscount, taxPaisa: lineTaxPaisa, lineTotalPaisa };
  });
  const discountPaisa = productDiscountPaisa + invoiceDiscountPaisa;
  const totalAmountPaisa = validPaisa(subtotalAmountPaisa - discountPaisa + taxPaisa, "INVALID_SALE", "Invoice total");
  if (!Number.isSafeInteger(input.initialCollectionPaisa) || input.initialCollectionPaisa < 0 || input.initialCollectionPaisa > totalAmountPaisa) throw new OfflineSalesError("INVALID_SALE", "Collected amount must be between zero and the invoice total.");
  if (input.initialCollectionPaisa > 0) {
    if (!input.paymentMode || !input.paymentReceiverName?.trim() || !input.paymentProofFileName) throw new OfflineSalesError("INVALID_SALE", "Payment mode, receiver name, and payment proof are required when payment is recorded.");
    if (input.paymentMode !== "cash" && !input.paymentTransactionId?.trim()) throw new OfflineSalesError("INVALID_SALE", "Enter the payment transaction ID for non-cash payments.");
  }
  if (input.initialCollectionPaisa < totalAmountPaisa && input.initialCollectionPaisa > 0) {
    if (!input.expectedNextPaymentDate) throw new OfflineSalesError("INVALID_SALE", "Set the expected date for the next partial payment.");
    saleDate(input.expectedNextPaymentDate);
  }
  const db = getDatabase();
  const existing = await db.select().from(offlineSales).where(eq(offlineSales.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing[0]) {
    const collections = await db.select({ amountPaisa: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections).where(eq(offlineSaleCollections.offlineSaleId, existing[0].id));
    return { sale: toRow(existing[0], collections.reduce((sum, collection) => sum + collection.amountPaisa, 0)), duplicate: true };
  }
  const dateKey = input.saleDate.replaceAll("-", "");
  const saleNumber = `OFF-${dateKey}-${randomUUID().slice(0, 8).toUpperCase()}`;
  return db.transaction(async (tx) => {
    const existingInvoice = await tx.select({ id: offlineSales.id }).from(offlineSales).where(eq(offlineSales.billingInvoiceNumber, billingInvoiceNumber)).limit(1);
    if (existingInvoice[0]) throw new OfflineSalesError("INVALID_SALE", "That billing invoice number has already been used.");
    const balances = await tx.select().from(inventoryBalances).where(and(inArray(inventoryBalances.productId, lines.map((line) => line.productId)), eq(inventoryBalances.warehouseLocationId, input.warehouseLocationId), eq(inventoryBalances.bucket, "retail"))).orderBy(inventoryBalances.productId).for("update");
    const balanceByProduct = new Map(balances.map((balance) => [balance.productId, balance]));
    for (const line of lines) {
      const balance = balanceByProduct.get(line.productId);
      const available = balance ? balance.onHand - balance.reserved : 0;
      if (!balance || available < line.quantity) throw new OfflineSalesError("INVALID_SALE", `${line.productName} has only ${available} available Retail units at the selected warehouse.`);
    }
    const [sale] = await tx.insert(offlineSales).values({
      saleNumber,
      idempotencyKey: input.idempotencyKey,
      saleDate: date,
      customerName,
      customerCompanyName,
      customerContact,
      billingInvoiceNumber,
      billingAddress,
      shippingAddress,
      shippingSameAsBilling,
      gstNumber: gstNumber?.toUpperCase() ?? null,
      customerType: input.customerType,
      isNewB2bCustomer: input.customerType === "b2b" && input.isNewB2bCustomer,
      totalAmountPaisa,
      subtotalAmountPaisa,
      discountPaisa,
      taxPaisa,
      reference,
      notes,
      orderType: input.orderType ?? "retail",
      location: input.location?.trim() || null,
      deliveryStatus: input.deliveryStatus ?? "packing",
      deliveryPartner: input.deliveryPartner?.trim() || null,
      deliveryCostPaisa: input.deliveryCostPaisa ?? null,
      lrNumber: input.lrNumber?.trim() || null,
      warehouseLocationId: input.warehouseLocationId,
      expectedNextPaymentDate: input.expectedNextPaymentDate ?? null,
      lines,
      createdBy: input.actorUsername,
    }).returning();
    for (const line of lines) {
      const balance = balanceByProduct.get(line.productId)!;
      await tx.update(inventoryBalances).set({ reserved: sql`${inventoryBalances.reserved} + ${line.quantity}`, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
    }
    if (input.initialCollectionPaisa > 0) {
      await tx.insert(offlineSaleCollections).values({
        offlineSaleId: sale.id,
        idempotencyKey: `${input.idempotencyKey}:initial`,
        amountPaisa: input.initialCollectionPaisa,
        collectedAt: date,
        reference,
        paymentMode: input.paymentMode,
        transactionId: input.paymentTransactionId?.trim() || null,
        receiverName: input.paymentReceiverName?.trim() || null,
        expectedNextPaymentDate: input.expectedNextPaymentDate ?? null,
        notes: "Initial collection recorded with sale",
        recordedBy: input.actorUsername,
      });
    }
    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "offline_sale.created",
      entityType: "offline_sale",
      entityId: sale.id,
      newValue: { saleNumber, billingInvoiceNumber, customerName, customerCompanyName, customerType: input.customerType, totalAmountPaisa, initialCollectionPaisa: input.initialCollectionPaisa, status: "packing", reservedProductCount: lines.length },
      reason: "Offline sales order raised; Retail stock reserved for warehouse preparation",
    });
    return { sale: toRow(sale, input.initialCollectionPaisa), duplicate: false };
  });
}

export async function recordOfflineSaleCollection(input: {
  saleId: string;
  amountPaisa: number;
  reference?: string;
  notes?: string;
  paymentMode: string;
  paymentTransactionId?: string;
  paymentReceiverName: string;
  paymentProofFileName: string;
  expectedNextPaymentDate?: string;
  actorUsername: string;
  idempotencyKey: string;
}): Promise<{ sale: OfflineSaleRow; duplicate: boolean }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new OfflineSalesError("INVALID_COLLECTION", "A valid submission key is required. Please try again.");
  const amountPaisa = validPaisa(input.amountPaisa, "INVALID_COLLECTION", "Collection amount");
  const reference = text(input.reference, "Receipt reference", 2, 120);
  const notes = text(input.notes, "Collection note", 2, 1_000);
  if (!input.paymentMode || !input.paymentReceiverName.trim()) throw new OfflineSalesError("INVALID_COLLECTION", "Payment mode and receiver name are required.");
  if (input.paymentMode !== "cash" && !input.paymentTransactionId?.trim()) throw new OfflineSalesError("INVALID_COLLECTION", "Enter the transaction ID for non-cash payments.");
  if (!input.paymentProofFileName?.trim()) throw new OfflineSalesError("INVALID_COLLECTION", "Upload proof of payment.");
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [duplicate] = await tx.select().from(offlineSaleCollections).where(eq(offlineSaleCollections.idempotencyKey, input.idempotencyKey)).limit(1);
    const [sale] = await tx.select().from(offlineSales).where(eq(offlineSales.id, input.saleId)).limit(1);
    if (!sale) throw new OfflineSalesError("NOT_FOUND", "This offline sale could not be found.");
    const collections = await tx.select({ amountPaisa: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections).where(eq(offlineSaleCollections.offlineSaleId, sale.id));
    const collectedBefore = collections.reduce((sum, collection) => sum + collection.amountPaisa, 0);
    if (duplicate) return { sale: toRow(sale, collectedBefore), duplicate: true };
    const pending = sale.totalAmountPaisa - collectedBefore;
    if (amountPaisa > pending) throw new OfflineSalesError("INVALID_COLLECTION", `Only ₹${(pending / 100).toFixed(2)} remains on this sale.`);
    if (amountPaisa < pending && !input.expectedNextPaymentDate) throw new OfflineSalesError("INVALID_COLLECTION", "Set the expected date for the next partial payment.");
    if (input.expectedNextPaymentDate) saleDate(input.expectedNextPaymentDate);
    await tx.insert(offlineSaleCollections).values({
      offlineSaleId: sale.id,
      idempotencyKey: input.idempotencyKey,
      amountPaisa,
      collectedAt: new Date(),
      reference,
      paymentMode: input.paymentMode,
      transactionId: input.paymentTransactionId?.trim() || null,
      receiverName: input.paymentReceiverName.trim(),
      expectedNextPaymentDate: input.expectedNextPaymentDate ?? null,
      notes,
      recordedBy: input.actorUsername,
    });
    await tx.update(offlineSales).set({ expectedNextPaymentDate: amountPaisa < pending ? input.expectedNextPaymentDate! : null, updatedAt: new Date() }).where(eq(offlineSales.id, sale.id));
    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "offline_sale.collection_recorded",
      entityType: "offline_sale",
      entityId: sale.id,
      newValue: { amountPaisa, reference },
      reason: "Offline payment collection recorded by sales workspace",
    });
    return { sale: { ...toRow(sale, collectedBefore + amountPaisa), expectedNextPaymentDate: amountPaisa < pending ? input.expectedNextPaymentDate! : null }, duplicate: false };
  });
}

export async function setOfflineSalePaymentReminder(input: { saleId: string; reminderDate: string; actorUsername: string }): Promise<OfflineSaleRow> {
  const reminderDate = input.reminderDate.trim();
  saleDate(reminderDate);
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [sale] = await tx.select().from(offlineSales).where(eq(offlineSales.id, input.saleId)).for("update").limit(1);
    if (!sale) throw new OfflineSalesError("NOT_FOUND", "This offline sale could not be found.");
    const collections = await tx.select({ amountPaisa: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections).where(eq(offlineSaleCollections.offlineSaleId, sale.id));
    const collected = collections.reduce((sum, collection) => sum + collection.amountPaisa, 0);
    if (collected >= sale.totalAmountPaisa) throw new OfflineSalesError("INVALID_SALE", "This order is fully paid; no payment reminder is needed.");
    const [updated] = await tx.update(offlineSales).set({ expectedNextPaymentDate: reminderDate, updatedAt: new Date() }).where(eq(offlineSales.id, sale.id)).returning();
    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "offline_sale.payment_reminder_set",
      entityType: "offline_sale",
      entityId: sale.id,
      previousValue: { expectedNextPaymentDate: sale.expectedNextPaymentDate },
      newValue: { expectedNextPaymentDate: reminderDate },
      reason: "Payment follow-up reminder scheduled",
    });
    return toRow(updated, collected);
  });
}

export async function updateOfflineSaleDeliveryStatus(input: { saleId: string; status: "packing" | "shipped" | "dispatched" | "delivered" | "cancelled"; actorUsername: string }) {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [sale] = await tx.select().from(offlineSales).where(eq(offlineSales.id, input.saleId)).for("update").limit(1);
    if (!sale) throw new OfflineSalesError("NOT_FOUND", "This sales order could not be found.");
    const previousStatus = sale.deliveryStatus;
    if (previousStatus === input.status) return { saleNumber: sale.saleNumber, status: previousStatus, duplicate: true };
    if (previousStatus === "delivered" || previousStatus === "cancelled") throw new OfflineSalesError("INVALID_SALE", `A ${previousStatus} order cannot be changed.`);
    if (input.status === "cancelled") {
      if (previousStatus === "dispatched") throw new OfflineSalesError("INVALID_SALE", "A dispatched order cannot be cancelled. Record a return instead.");
      const lines = sale.lines.filter((line) => line.productId);
      for (const line of lines) {
        const [balance] = await tx.select().from(inventoryBalances).where(and(eq(inventoryBalances.productId, line.productId!), eq(inventoryBalances.warehouseLocationId, sale.warehouseLocationId!), eq(inventoryBalances.bucket, "retail"))).for("update").limit(1);
        if (balance) await tx.update(inventoryBalances).set({ reserved: sql`GREATEST(${inventoryBalances.reserved} - ${line.quantity}, 0)`, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
      }
    } else {
      const next = previousStatus === "packing" ? "shipped" : previousStatus === "shipped" ? "dispatched" : previousStatus === "dispatched" ? "delivered" : null;
      if (input.status !== next) throw new OfflineSalesError("INVALID_SALE", `Move this order from ${previousStatus} to ${next ?? "a terminal status"} first.`);
      if (input.status === "dispatched") {
        const lines = sale.lines.filter((line) => line.productId);
        if (!sale.warehouseLocationId || lines.length !== sale.lines.length) throw new OfflineSalesError("INVALID_SALE", "This order is missing its warehouse or product mapping and cannot be dispatched.");
        if (await tx.select({ id: inventoryTransactions.id }).from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, `offline-sale-dispatch:${sale.id}`)).limit(1).then(rows => rows.length)) throw new OfflineSalesError("INVALID_SALE", "This order has already issued stock; contact a manager to review its status.");
        const balances = await tx.select().from(inventoryBalances).where(and(inArray(inventoryBalances.productId, lines.map((line) => line.productId!)), eq(inventoryBalances.warehouseLocationId, sale.warehouseLocationId), eq(inventoryBalances.bucket, "retail"))).orderBy(inventoryBalances.productId).for("update");
        const balanceByProduct = new Map(balances.map((balance) => [balance.productId, balance]));
        for (const line of lines) {
          const balance = balanceByProduct.get(line.productId!);
          if (!balance || balance.reserved < line.quantity || balance.onHand < line.quantity) throw new OfflineSalesError("INVALID_SALE", `${line.productName} no longer has enough reserved Retail stock to dispatch this order.`);
        }
        const transactionNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${uuid().slice(0, 8).toUpperCase()}`;
        const [transaction] = await tx.insert(inventoryTransactions).values({ transactionNumber, type: "retail_issue", idempotencyKey: `offline-sale-dispatch:${sale.id}`, referenceId: sale.billingInvoiceNumber ?? sale.saleNumber, actorUsername: input.actorUsername, reason: "Sales order dispatched from warehouse", occurredAt: new Date(), metadata: { destination: sale.customerName, offlineSaleId: sale.id, saleNumber: sale.saleNumber, billingInvoiceNumber: sale.billingInvoiceNumber, orderValuePaisa: sale.totalAmountPaisa, totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0), deliveryStatus: "dispatched" } }).returning({ id: inventoryTransactions.id });
        const txLines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
        for (const line of lines) {
          const balance = balanceByProduct.get(line.productId!)!;
          const closing = balance.onHand - line.quantity;
          await tx.update(inventoryBalances).set({ onHand: closing, reserved: sql`${inventoryBalances.reserved} - ${line.quantity}`, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
          txLines.push({ transactionId: transaction.id, productId: line.productId!, warehouseLocationId: sale.warehouseLocationId, bucket: "retail", quantityDelta: -line.quantity, openingBalance: balance.onHand, closingBalance: closing });
        }
        if (txLines.length) await tx.insert(inventoryTransactionLines).values(txLines);
      }
    }
    await tx.update(offlineSales).set({ deliveryStatus: input.status, updatedAt: new Date() }).where(eq(offlineSales.id, sale.id));
    await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "offline_sale.delivery_status_updated", entityType: "offline_sale", entityId: sale.id, previousValue: { deliveryStatus: previousStatus }, newValue: { deliveryStatus: input.status }, reason: input.status === "cancelled" ? "Sales order cancelled; reserved Retail stock released" : "Warehouse fulfillment status updated" });
    return { saleNumber: sale.saleNumber, status: input.status, duplicate: false };
  });
}
