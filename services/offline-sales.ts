import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { auditEvents, offlineSaleCollections, offlineSales } from "@/db/schema";
import type { OfflineCustomerType, OfflinePaymentStatus, OfflineSaleRow, OfflineSalesOverview } from "@/types/offline-sales";

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
    customerContact: sale.customerContact,
    customerType: sale.customerType as OfflineCustomerType,
    isNewB2bCustomer: sale.isNewB2bCustomer,
    totalAmountPaisa: sale.totalAmountPaisa,
    collectedAmountPaisa: collected,
    pendingAmountPaisa: sale.totalAmountPaisa - collected,
    paymentStatus: paymentStatus(sale.totalAmountPaisa, collected),
    reference: sale.reference,
    notes: sale.notes,
    createdBy: sale.createdBy,
  };
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
  customerName: string;
  customerContact?: string;
  customerType: OfflineCustomerType;
  isNewB2bCustomer: boolean;
  totalAmountPaisa: number;
  initialCollectionPaisa: number;
  reference?: string;
  notes?: string;
  actorUsername: string;
  idempotencyKey: string;
}): Promise<{ sale: OfflineSaleRow; duplicate: boolean }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new OfflineSalesError("INVALID_SALE", "A valid submission key is required. Please try again.");
  const date = saleDate(input.saleDate);
  const customerName = text(input.customerName, "Customer name", 2, 160, true)!;
  const customerContact = text(input.customerContact, "Customer contact", 3, 80);
  const reference = text(input.reference, "Invoice / reference", 2, 120);
  const notes = text(input.notes, "Notes", 2, 1_000);
  if (input.customerType !== "retail" && input.customerType !== "b2b") throw new OfflineSalesError("INVALID_SALE", "Select Retail or B2B customer.");
  const totalAmountPaisa = validPaisa(input.totalAmountPaisa, "INVALID_SALE", "Sale amount");
  if (!Number.isSafeInteger(input.initialCollectionPaisa) || input.initialCollectionPaisa < 0 || input.initialCollectionPaisa > totalAmountPaisa) {
    throw new OfflineSalesError("INVALID_SALE", "Collected amount must be between zero and the sale amount.");
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
    const [sale] = await tx.insert(offlineSales).values({
      saleNumber,
      idempotencyKey: input.idempotencyKey,
      saleDate: date,
      customerName,
      customerContact,
      customerType: input.customerType,
      isNewB2bCustomer: input.customerType === "b2b" && input.isNewB2bCustomer,
      totalAmountPaisa,
      reference,
      notes,
      createdBy: input.actorUsername,
    }).returning();
    if (input.initialCollectionPaisa > 0) {
      await tx.insert(offlineSaleCollections).values({
        offlineSaleId: sale.id,
        idempotencyKey: `${input.idempotencyKey}:initial`,
        amountPaisa: input.initialCollectionPaisa,
        collectedAt: date,
        reference,
        notes: "Initial collection recorded with sale",
        recordedBy: input.actorUsername,
      });
    }
    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "offline_sale.created",
      entityType: "offline_sale",
      entityId: sale.id,
      newValue: { saleNumber, customerName, customerType: input.customerType, totalAmountPaisa, initialCollectionPaisa: input.initialCollectionPaisa },
      reason: "Offline sale recorded by sales workspace",
    });
    return { sale: toRow(sale, input.initialCollectionPaisa), duplicate: false };
  });
}

export async function recordOfflineSaleCollection(input: {
  saleId: string;
  amountPaisa: number;
  reference?: string;
  notes?: string;
  actorUsername: string;
  idempotencyKey: string;
}): Promise<{ sale: OfflineSaleRow; duplicate: boolean }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new OfflineSalesError("INVALID_COLLECTION", "A valid submission key is required. Please try again.");
  const amountPaisa = validPaisa(input.amountPaisa, "INVALID_COLLECTION", "Collection amount");
  const reference = text(input.reference, "Receipt reference", 2, 120);
  const notes = text(input.notes, "Collection note", 2, 1_000);
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
    await tx.insert(offlineSaleCollections).values({
      offlineSaleId: sale.id,
      idempotencyKey: input.idempotencyKey,
      amountPaisa,
      collectedAt: new Date(),
      reference,
      notes,
      recordedBy: input.actorUsername,
    });
    await tx.insert(auditEvents).values({
      actorUsername: input.actorUsername,
      action: "offline_sale.collection_recorded",
      entityType: "offline_sale",
      entityId: sale.id,
      newValue: { amountPaisa, reference },
      reason: "Offline payment collection recorded by sales workspace",
    });
    return { sale: toRow(sale, collectedBefore + amountPaisa), duplicate: false };
  });
}
