import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { randomUUID as uuid } from "node:crypto";
import { auditEvents, integrationOutbox, inventoryBalances, inventoryTransactionLines, inventoryTransactions, offlineSaleCollections, offlineSaleDocuments, offlineSales, products, salesCustomers, shopifyMappings, warehouseLocations } from "@/db/schema";
import { fetchShopifyPricesBySku } from "@/services/shopify-inventory";
import { listedOfflineUnitPricePaisa } from "@/lib/offline-product-pricing";
import { calculateInvoice } from "@/lib/sales/invoice-calc";
import { isPhysicalUnitProduct, physicalUnitDisplayName } from "@/lib/inventory/physical-units";
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
    pendingAmountPaisa: sale.deliveryStatus === "cancelled" ? 0 : sale.totalAmountPaisa - collected,
    paymentStatus: paymentStatus(sale.totalAmountPaisa, collected),
    reference: sale.reference,
    notes: sale.notes,
    orderType: sale.orderType,
    requestedDispatchDate: sale.requestedDispatchDate,
    location: sale.location,
    deliveryStatus: sale.deliveryStatus,
    deliveredAt: sale.deliveredAt?.toISOString() ?? null,
    deliveryPartner: sale.deliveryPartner,
    deliveryCostPaisa: sale.deliveryCostPaisa,
    lrNumber: sale.lrNumber,
    trackingUrl: sale.trackingUrl,
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
    db.select({ productId: inventoryBalances.productId, warehouseLocationId: inventoryBalances.warehouseLocationId, bucket: inventoryBalances.bucket, onHand: inventoryBalances.onHand, reserved: inventoryBalances.reserved }).from(inventoryBalances).where(inArray(inventoryBalances.bucket, ["retail", "buffer", "online"])),
    fetchShopifyPricesBySku().catch(() => new Map<string, number>()),
    db.select({ id: salesCustomers.id, name: salesCustomers.name, companyName: salesCustomers.companyName, address: salesCustomers.address, phone: salesCustomers.phone, gstNumber: salesCustomers.gstNumber }).from(salesCustomers).where(eq(salesCustomers.active, true)).orderBy(salesCustomers.name),
  ]);
  return {
    products: productsRows.flatMap((product) => {
      if (!isPhysicalUnitProduct(product.name)) return [];
      const displayName = physicalUnitDisplayName(product.name);
      return [{ ...product, name: displayName, unitPricePaisa: product.unitPricePaisa > 0 ? product.unitPricePaisa : listedOfflineUnitPricePaisa(displayName) ?? livePrices.get(product.sku.trim().toUpperCase()) ?? product.unitPricePaisa }];
    }),
    locations,
    retailBalances: [...retailRows.reduce((totals, row) => {
      const key = `${row.productId}:${row.warehouseLocationId}`;
      totals.set(key, { productId: row.productId, warehouseLocationId: row.warehouseLocationId, available: (totals.get(key)?.available ?? 0) + Math.max(0, row.onHand - row.reserved) });
      return totals;
    }, new Map<string, { productId: string; warehouseLocationId: string; available: number }>()).values()],
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

export async function getOfflineSalesOverview(range: { from: string; to: string }, options?: { createdBy?: string }): Promise<OfflineSalesOverview> {
  const from = rangeBoundary(range.from, "start");
  const to = rangeBoundary(range.to, "end");
  if (from > to) throw new OfflineSalesError("INVALID_SALE", "The reporting start date must be before the end date.");
  const db = getDatabase();
  const [allSales, allCollections, periodSales, periodCollections, amendments] = await Promise.all([
    db.select().from(offlineSales).orderBy(desc(offlineSales.saleDate)),
    db.select({ offlineSaleId: offlineSaleCollections.offlineSaleId, amountPaisa: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections),
    db.select().from(offlineSales).where(and(gte(offlineSales.saleDate, from), lte(offlineSales.saleDate, to))).orderBy(desc(offlineSales.saleDate)),
    db.select({ amountPaisa: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections).where(and(gte(offlineSaleCollections.collectedAt, from), lte(offlineSaleCollections.collectedAt, to))),
    db.select({ entityId: auditEvents.entityId, action: auditEvents.action, reason: auditEvents.reason, createdAt: auditEvents.createdAt }).from(auditEvents).where(and(eq(auditEvents.entityType, "offline_sale"), inArray(auditEvents.action, ["offline_sale.corrected", "offline_sale.cancelled"]))).orderBy(auditEvents.createdAt),
  ]);
  const collectionsBySale = mapCollections(allCollections);
  const allRows = allSales.map((sale) => {
    const history = amendments.filter(event => event.entityId === sale.id);
    const corrections = history.filter(event => event.action === "offline_sale.corrected");
    return { ...toRow(sale, collectionsBySale.get(sale.id) ?? 0), correctionCount: corrections.length, lastCorrectedAt: corrections.at(-1)?.createdAt.toISOString() ?? null, cancellationNote: history.find(event => event.action === "offline_sale.cancelled")?.reason ?? null };
  });
  const periodRows = periodSales.map((sale) => toRow(sale, collectionsBySale.get(sale.id) ?? 0));
  const salesAmountPaisa = periodRows.filter(sale => sale.deliveryStatus !== "cancelled").reduce((sum, sale) => sum + sale.totalAmountPaisa, 0);
  const collectedAmountPaisa = periodCollections.reduce((sum, collection) => sum + collection.amountPaisa, 0);
  const outstandingSales = allRows.filter((sale) => sale.pendingAmountPaisa > 0).sort((left, right) => right.pendingAmountPaisa - left.pendingAmountPaisa || right.saleDate.localeCompare(left.saleDate));
  return {
    salesAmountPaisa,
    collectedAmountPaisa,
    openReceivablesPaisa: outstandingSales.reduce((sum, sale) => sum + sale.pendingAmountPaisa, 0),
    newB2bCustomers: periodRows.filter((sale) => sale.deliveryStatus !== "cancelled" && sale.customerType === "b2b" && sale.isNewB2bCustomer).length,
    salesCount: periodRows.filter(sale => sale.deliveryStatus !== "cancelled").length,
    recentSales: periodRows.slice(0, 20),
    outstandingSales: outstandingSales.slice(0, 12),
    ...(options?.createdBy ? { submittedOrders: allRows.filter((sale) => sale.createdBy === options.createdBy) } : {}),
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
  /** Buyer outside Telangana: bill IGST instead of CGST + SGST. */
  interState?: boolean;
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
  requestedDispatchDate?: string;
  location?: string;
  deliveryStatus?: string;
  deliveryPartner?: string;
  deliveryCostPaisa?: number;
  lrNumber?: string;
  lines: { productId: string; productName: string; sku: string; quantity: number; unitPricePaisa: number; gstRateBps: number; discountPaisa: number }[];
  actorUsername: string;
  idempotencyKey: string;
}): Promise<{ sale: OfflineSaleRow; duplicate: boolean; stockTransferTransactionId: string | null; stockTransfers: { productId: string; movedFromBuffer: number; movedFromOnline: number }[] }> {
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
  const requestedDispatchDate = input.requestedDispatchDate?.trim() || null;
  if (requestedDispatchDate) saleDate(requestedDispatchDate);
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
    return line;
  });
  const taxableBeforeInvoiceDiscount = subtotalAmountPaisa - productDiscountPaisa;
  const invoiceDiscountPaisa = input.additionalDiscountPaisa ?? 0;
  if (!Number.isSafeInteger(invoiceDiscountPaisa) || invoiceDiscountPaisa < 0 || invoiceDiscountPaisa > taxableBeforeInvoiceDiscount) throw new OfflineSalesError("INVALID_SALE", "Extra invoice discount cannot exceed the remaining invoice value.");
  // Bill the same way the accounts team's invoice does (rate excl. GST, CGST/SGST or IGST per slab, round off).
  const invoice = calculateInvoice(baseLines, invoiceDiscountPaisa, { interState: input.interState === true });
  const lines = baseLines.map((line, index) => {
    const calculated = invoice.lines[index];
    return { productId: line.productId, productName: line.productName, sku: line.sku, quantity: line.quantity, unitPricePaisa: line.unitPricePaisa, gstRateBps: line.gstRateBps, discountPaisa: calculated.discountPaisa, rateInclusivePaisa: calculated.rateInclusivePaisa, ratePaisa: calculated.ratePaisa, taxablePaisa: calculated.taxablePaisa, taxPaisa: calculated.taxPaisa, lineTotalPaisa: calculated.lineTotalPaisa };
  });
  const { discountPaisa, taxPaisa } = invoice;
  const totalAmountPaisa = validPaisa(invoice.totalAmountPaisa, "INVALID_SALE", "Invoice total");
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
    const [transfer] = await db.select({ id: inventoryTransactions.id, metadata: inventoryTransactions.metadata }).from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, `${input.idempotencyKey}:retail-replenish`)).limit(1);
    const stockTransfers = Array.isArray(transfer?.metadata.stockTransfers) ? transfer.metadata.stockTransfers as { productId: string; movedFromBuffer: number; movedFromOnline: number }[] : [];
    return { sale: toRow(existing[0], collections.reduce((sum, collection) => sum + collection.amountPaisa, 0)), duplicate: true, stockTransferTransactionId: transfer?.id ?? null, stockTransfers };
  }
  const dateKey = input.saleDate.replaceAll("-", "");
  const saleNumber = `OFF-${dateKey}-${randomUUID().slice(0, 8).toUpperCase()}`;
  return db.transaction(async (tx) => {
    const existingInvoice = await tx.select({ id: offlineSales.id }).from(offlineSales).where(and(eq(offlineSales.billingInvoiceNumber, billingInvoiceNumber), ne(offlineSales.deliveryStatus, "cancelled"))).limit(1);
    if (existingInvoice[0]) throw new OfflineSalesError("INVALID_SALE", "That billing invoice number belongs to an order that has not been cancelled.");
    const productIds = lines.map((line) => line.productId);
    const catalog = await tx.select({ id: products.id, name: products.name, active: products.active }).from(products).where(inArray(products.id, productIds));
    if (catalog.length !== productIds.length || catalog.some((product) => !product.active || !isPhysicalUnitProduct(product.name))) throw new OfflineSalesError("INVALID_SALE", "Choose active individual physical products. Shopify pack listings and bundles do not hold separate warehouse stock.");
    const buckets = ["retail", "buffer", "online"] as const;
    await tx.insert(inventoryBalances).values(productIds.flatMap((productId) => buckets.map((bucket) => ({ productId, warehouseLocationId: input.warehouseLocationId, bucket }))))
      .onConflictDoNothing({ target: [inventoryBalances.productId, inventoryBalances.warehouseLocationId, inventoryBalances.bucket] });
    const balances = await tx.select().from(inventoryBalances).where(and(inArray(inventoryBalances.productId, productIds), eq(inventoryBalances.warehouseLocationId, input.warehouseLocationId), inArray(inventoryBalances.bucket, [...buckets]))).orderBy(inventoryBalances.productId, inventoryBalances.bucket).for("update");
    const balanceByScope = new Map(balances.map((balance) => [`${balance.productId}:${balance.bucket}`, balance]));
    const stockPlans = lines.map((line) => {
      const retail = balanceByScope.get(`${line.productId}:retail`)!;
      const buffer = balanceByScope.get(`${line.productId}:buffer`)!;
      const online = balanceByScope.get(`${line.productId}:online`)!;
      const retailAvailable = Math.max(0, retail.onHand - retail.reserved);
      let shortfall = Math.max(0, line.quantity - retailAvailable);
      const movedFromBuffer = Math.min(shortfall, Math.max(0, buffer.onHand - buffer.reserved));
      shortfall -= movedFromBuffer;
      const movedFromOnline = Math.min(shortfall, Math.max(0, online.onHand - online.reserved));
      shortfall -= movedFromOnline;
      if (shortfall > 0) throw new OfflineSalesError("INVALID_SALE", `${line.productName} has only ${retailAvailable + Math.max(0, buffer.onHand - buffer.reserved) + Math.max(0, online.onHand - online.reserved)} available physical units across Retail, Buffer, and Online at the selected warehouse.`);
      return { line, retail, buffer, online, movedFromBuffer, movedFromOnline };
    });
    const onlinePlans = stockPlans.filter((plan) => plan.movedFromOnline > 0);
    const mappings = onlinePlans.length ? await tx.select().from(shopifyMappings).where(and(inArray(shopifyMappings.productId, [...new Set(onlinePlans.map((plan) => plan.line.productId))]), eq(shopifyMappings.status, "mapped"))) : [];
    const mappingByProduct = new Map<string, typeof shopifyMappings.$inferSelect>();
    for (const mapping of mappings) if (!mappingByProduct.has(mapping.productId)) mappingByProduct.set(mapping.productId, mapping);
    for (const plan of onlinePlans) if (!mappingByProduct.has(plan.line.productId)) throw new OfflineSalesError("INVALID_SALE", `${plan.line.productName} has Online units but no verified Shopify mapping. Reconcile its listing before moving those units to Retail.`);
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
      requestedDispatchDate,
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
    const stockTransfers = stockPlans.map((plan) => ({ productId: plan.line.productId, movedFromBuffer: plan.movedFromBuffer, movedFromOnline: plan.movedFromOnline }));
    const hasTransfers = stockPlans.some((plan) => plan.movedFromBuffer > 0 || plan.movedFromOnline > 0);
    let stockTransferTransactionId: string | null = null;
    let transferLines: (typeof inventoryTransactionLines.$inferInsert)[] = [];
    const transferPrevious: Record<string, number> = {};
    const transferNext: Record<string, number> = {};
    if (hasTransfers) {
      const transferNumber = `TX-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const [transfer] = await tx.insert(inventoryTransactions).values({
        transactionNumber: transferNumber,
        type: "channel_transfer",
        idempotencyKey: `${input.idempotencyKey}:retail-replenish`,
        referenceId: billingInvoiceNumber,
        actorUsername: input.actorUsername,
        reason: "Retail sales order replenishment from Buffer and Online stock",
        occurredAt: date,
        metadata: { action: "retail_sales_order_replenishment", offlineSaleId: sale.id, saleNumber, stockTransfers },
      }).returning({ id: inventoryTransactions.id });
      stockTransferTransactionId = transfer.id;
    }
    for (const plan of stockPlans) {
      const { line, retail, buffer, online, movedFromBuffer, movedFromOnline } = plan;
      if (movedFromBuffer > 0) {
        const closing = buffer.onHand - movedFromBuffer;
        await tx.update(inventoryBalances).set({ onHand: closing, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, buffer.id));
        transferLines.push({ transactionId: stockTransferTransactionId!, productId: line.productId, warehouseLocationId: input.warehouseLocationId, bucket: "buffer", quantityDelta: -movedFromBuffer, openingBalance: buffer.onHand, closingBalance: closing });
        transferPrevious[`${line.productId}:buffer`] = buffer.onHand;
        transferNext[`${line.productId}:buffer`] = closing;
      }
      if (movedFromOnline > 0) {
        const closing = online.onHand - movedFromOnline;
        await tx.update(inventoryBalances).set({ onHand: closing, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, online.id));
        transferLines.push({ transactionId: stockTransferTransactionId!, productId: line.productId, warehouseLocationId: input.warehouseLocationId, bucket: "online", quantityDelta: -movedFromOnline, openingBalance: online.onHand, closingBalance: closing });
        transferPrevious[`${line.productId}:online`] = online.onHand;
        transferNext[`${line.productId}:online`] = closing;
      }
      const movedToRetail = movedFromBuffer + movedFromOnline;
      const retailClosing = retail.onHand + movedToRetail;
      await tx.update(inventoryBalances).set({ onHand: retailClosing, reserved: sql`${inventoryBalances.reserved} + ${line.quantity}`, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, retail.id));
      if (movedToRetail > 0) {
        transferLines.push({ transactionId: stockTransferTransactionId!, productId: line.productId, warehouseLocationId: input.warehouseLocationId, bucket: "retail", quantityDelta: movedToRetail, openingBalance: retail.onHand, closingBalance: retailClosing });
        transferPrevious[`${line.productId}:retail`] = retail.onHand;
        transferNext[`${line.productId}:retail`] = retailClosing;
      }
    }
    if (hasTransfers) {
      if (transferLines.length) await tx.insert(inventoryTransactionLines).values(transferLines);
      if (onlinePlans.length) await tx.insert(integrationOutbox).values(onlinePlans.map((plan, index) => {
        const mapping = mappingByProduct.get(plan.line.productId)!;
        return { transactionId: stockTransferTransactionId!, operation: "shopify_inventory_adjust", idempotencyKey: `${input.idempotencyKey}:retail-replenish:shopify:${index}`, payload: { shopifyInventoryItemId: mapping.shopifyInventoryItemId, shopifyLocationId: mapping.shopifyLocationId, quantityDelta: -plan.movedFromOnline, reason: "correction" } };
      }));
      await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "inventory.channel_transfer", entityType: "inventory_transaction", entityId: stockTransferTransactionId!, previousValue: transferPrevious, newValue: transferNext, reason: "Individual units shifted into Retail to cover sales order demand." });
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
      newValue: { saleNumber, billingInvoiceNumber, customerName, customerCompanyName, customerType: input.customerType, totalAmountPaisa, initialCollectionPaisa: input.initialCollectionPaisa, requestedDispatchDate, status: "packing", reservedProductCount: lines.length, stockTransferTransactionId },
      reason: hasTransfers ? "Offline sales order raised; stock moved into Retail from Buffer / Online and reserved for warehouse preparation" : "Offline sales order raised; Retail stock reserved for warehouse preparation",
    });
    return { sale: toRow(sale, input.initialCollectionPaisa), duplicate: false, stockTransferTransactionId, stockTransfers };
  });
}

export async function recordOfflineSaleCollection(input: {
  saleId: string;
  ownOrdersOnly?: boolean;
  proof?: { fileName: string; contentType: string; fileSize: number; contentBase64: string };
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
    const [sale] = await tx.select().from(offlineSales).where(eq(offlineSales.id, input.saleId)).for("update").limit(1);
    if (!sale) throw new OfflineSalesError("NOT_FOUND", "This offline sale could not be found.");
    if (input.ownOrdersOnly && sale.createdBy !== input.actorUsername) throw new OfflineSalesError("NOT_FOUND", "This order is not available to your account.");
    const [duplicate] = await tx.select().from(offlineSaleCollections).where(eq(offlineSaleCollections.idempotencyKey, input.idempotencyKey)).limit(1);
    if (duplicate && duplicate.offlineSaleId !== sale.id) throw new OfflineSalesError("INVALID_COLLECTION", "Payment submission key belongs to another order.");
    const collections = await tx.select({ amountPaisa: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections).where(eq(offlineSaleCollections.offlineSaleId, sale.id));
    const collectedBefore = collections.reduce((sum, collection) => sum + collection.amountPaisa, 0);
    if (duplicate) return { sale: toRow(sale, collectedBefore), duplicate: true };
    if (sale.deliveryStatus === "cancelled") throw new OfflineSalesError("INVALID_COLLECTION", "Payments cannot be added to a cancelled order.");
    const pending = sale.totalAmountPaisa - collectedBefore;
    if (amountPaisa > pending) throw new OfflineSalesError("INVALID_COLLECTION", `Only ₹${(pending / 100).toFixed(2)} remains on this sale.`);
    if (amountPaisa < pending && !input.expectedNextPaymentDate) throw new OfflineSalesError("INVALID_COLLECTION", "Set the expected date for the next partial payment.");
    if (input.expectedNextPaymentDate) saleDate(input.expectedNextPaymentDate);
    const [collection] = await tx.insert(offlineSaleCollections).values({
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
    }).returning({ id: offlineSaleCollections.id });
    let proofDocumentId: string | null = null;
    if (input.proof) {
      const [document] = await tx.insert(offlineSaleDocuments).values({ ...input.proof, offlineSaleId: sale.id, kind: "payment_proof", uploadedBy: input.actorUsername }).returning({ id: offlineSaleDocuments.id });
      proofDocumentId = document.id;
    }
    await tx.update(offlineSales).set({ expectedNextPaymentDate: amountPaisa < pending ? input.expectedNextPaymentDate! : null, updatedAt: new Date() }).where(eq(offlineSales.id, sale.id));
    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "offline_sale.collection_recorded",
      entityType: "offline_sale",
      entityId: sale.id,
      newValue: { amountPaisa, reference, collectionId: collection.id, proofDocumentId, paymentMode: input.paymentMode, transactionId: input.paymentTransactionId, receiverName: input.paymentReceiverName },
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

export async function updateOfflineSaleDeliveryStatus(input: { saleId: string; status: "packing" | "shipped" | "out_for_delivery" | "dispatched" | "delivered" | "cancelled"; deliveryPartner?: string; trackingNumber?: string; trackingUrl?: string; actorUsername: string }) {
  const deliveryPartner = input.deliveryPartner?.trim() ?? "";
  const trackingNumber = input.trackingNumber?.trim() ?? "";
  const trackingUrl = input.trackingUrl?.trim() ?? "";
  if (deliveryPartner.length > 100 || trackingNumber.length > 120 || trackingUrl.length > 500) throw new OfflineSalesError("INVALID_SALE", "Delivery and tracking details exceed the allowed length.");
  if (trackingUrl) { let url: URL; try { url = new URL(trackingUrl); } catch { throw new OfflineSalesError("INVALID_SALE", "Enter a valid tracking URL."); } if (url.protocol !== "https:") throw new OfflineSalesError("INVALID_SALE", "Tracking URL must use HTTPS."); }
  if (["shipped", "out_for_delivery"].includes(input.status) && !trackingNumber) throw new OfflineSalesError("INVALID_SALE", "Enter a tracking ID before marking the order shipped or out for delivery.");
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [sale] = await tx.select().from(offlineSales).where(eq(offlineSales.id, input.saleId)).for("update").limit(1);
    if (!sale) throw new OfflineSalesError("NOT_FOUND", "This sales order could not be found.");
    const previousStatus = sale.deliveryStatus;
    if (previousStatus === "delivered" || previousStatus === "cancelled") throw new OfflineSalesError("INVALID_SALE", `A ${previousStatus} order cannot be changed.`);
    if (input.status === "cancelled") {
      if (["shipped", "out_for_delivery", "dispatched"].includes(previousStatus)) throw new OfflineSalesError("INVALID_SALE", "A shipped order cannot be cancelled. Record a return instead.");
      const lines = sale.lines.filter((line) => line.productId);
      for (const line of lines) {
        const [balance] = await tx.select().from(inventoryBalances).where(and(eq(inventoryBalances.productId, line.productId!), eq(inventoryBalances.warehouseLocationId, sale.warehouseLocationId!), eq(inventoryBalances.bucket, "retail"))).for("update").limit(1);
        if (balance) await tx.update(inventoryBalances).set({ reserved: sql`GREATEST(${inventoryBalances.reserved} - ${line.quantity}, 0)`, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance.id));
      }
    } else if (previousStatus !== input.status) {
      const allowedNext: Record<string, string[]> = {
        packing: ["shipped", "out_for_delivery", "delivered"],
        shipped: ["out_for_delivery", "delivered"],
        out_for_delivery: ["delivered"],
        dispatched: ["delivered"],
      };
      if (!allowedNext[previousStatus]?.includes(input.status)) throw new OfflineSalesError("INVALID_SALE", `Cannot move this order from ${previousStatus} to ${input.status}. Choose a later delivery status.`);
      const firstDispatchStatus = previousStatus === "packing" && ["shipped", "out_for_delivery", "delivered"].includes(input.status);
      if (firstDispatchStatus) {
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
        const [transaction] = await tx.insert(inventoryTransactions).values({ transactionNumber, type: "retail_issue", idempotencyKey: `offline-sale-dispatch:${sale.id}`, referenceId: sale.billingInvoiceNumber ?? sale.saleNumber, actorUsername: input.actorUsername, reason: `Sales order marked ${input.status.replaceAll("_", " ")} from warehouse`, occurredAt: new Date(), metadata: { destination: sale.customerName, offlineSaleId: sale.id, saleNumber: sale.saleNumber, billingInvoiceNumber: sale.billingInvoiceNumber, orderValuePaisa: sale.totalAmountPaisa, totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0), deliveryStatus: input.status } }).returning({ id: inventoryTransactions.id });
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
    const updatedAt = new Date();
    await tx.update(offlineSales).set({ deliveryStatus: input.status, deliveredAt: input.status === "delivered" ? sale.deliveredAt ?? updatedAt : sale.deliveredAt, deliveryPartner: deliveryPartner || sale.deliveryPartner, lrNumber: trackingNumber || sale.lrNumber, trackingUrl: trackingUrl || sale.trackingUrl, updatedAt }).where(eq(offlineSales.id, sale.id));
    await tx.insert(auditEvents).values({ actorUsername: input.actorUsername, action: "offline_sale.delivery_status_updated", entityType: "offline_sale", entityId: sale.id, previousValue: { deliveryStatus: previousStatus, deliveryPartner: sale.deliveryPartner, lrNumber: sale.lrNumber, trackingUrl: sale.trackingUrl }, newValue: { deliveryStatus: input.status, deliveryPartner: deliveryPartner || sale.deliveryPartner, trackingNumber: trackingNumber || sale.lrNumber, trackingUrl: trackingUrl || sale.trackingUrl }, reason: input.status === "cancelled" ? "Sales order cancelled; reserved Retail stock released" : "Warehouse fulfillment status and tracking updated" });
    return { saleNumber: sale.saleNumber, status: input.status, duplicate: false };
  });
}
