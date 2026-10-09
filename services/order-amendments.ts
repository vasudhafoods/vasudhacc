import { normalizeInvoiceNumber } from "@/lib/sales/invoice-number";
import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { auditEvents, inventoryBalances, inventoryTransactions, offlineSaleCollections, offlineSaleDocuments, offlineSales, products } from "@/db/schema";
import { amendmentTotals, reservationAfterCorrection, type AmendmentLine } from "@/lib/sales/order-amendment";
import { rebalanceOfflineStock } from "@/services/offline-sales";

export class OrderAmendmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const fail = (message: string, status = 400): never => { throw new OrderAmendmentError(message, status); };
const snapshot = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));
const actions = ["offline_sale.corrected", "offline_sale.cancelled"];
type Actor = { username: string; role: string };
function checkOwner(sale: typeof offlineSales.$inferSelect | undefined, actor: Actor) {
  if (!sale) return fail("Order not found.", 404);
  if (actor.role === "retail_sales" && sale.createdBy !== actor.username) fail("You can only amend orders you created.", 403);
  return sale;
}
function clean(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) return fail(`${label} must be ${min}–${max} characters.`);
  return value.trim();
}
function date(value: unknown, label: string) {
  const text = clean(value, label, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`)) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text) return fail(`Enter a valid ${label.toLowerCase()}.`);
  return text;
}

export async function readOrderAmendments(saleId: string, actor: Actor) {
  return getDatabase().transaction(async tx => {
    const [found] = await tx.select().from(offlineSales).where(eq(offlineSales.id, saleId)).for("share");
    const sale = checkOwner(found, actor);
    const history = await tx.select({ id: auditEvents.id, action: auditEvents.action, actor: auditEvents.actorUsername, reason: auditEvents.reason, editedAt: auditEvents.createdAt, before: auditEvents.previousValue, after: auditEvents.newValue }).from(auditEvents).where(and(eq(auditEvents.entityType, "offline_sale"), eq(auditEvents.entityId, saleId), inArray(auditEvents.action, actions))).orderBy(asc(auditEvents.createdAt));
    const documents = await tx.select({ id: offlineSaleDocuments.id, fileName: offlineSaleDocuments.fileName, createdAt: offlineSaleDocuments.createdAt }).from(offlineSaleDocuments).where(and(eq(offlineSaleDocuments.offlineSaleId, saleId), eq(offlineSaleDocuments.kind, "invoice"))).orderBy(asc(offlineSaleDocuments.createdAt));
    return { sale, documents, history };
  });
}

export async function amendOrder(saleId: string, actor: Actor, body: Record<string, unknown>, file?: File) {
  const action = body.action;
  if (action !== "cancel" && action !== "edit") fail("Choose edit or cancel.");
  const reason = clean(body.reason, "Correction / cancellation note", 3, 1000);
  const expectedVersion = clean(body.expectedVersion, "Order version", 20, 40);
  let document: { fileName: string; contentType: string; fileSize: number; contentBase64: string } | undefined;
  if (file) {
    if (file.size <= 0 || file.size > 3 * 1024 * 1024 || !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) fail("Invoice must be a PDF, JPG, PNG, or WebP up to 3 MB.");
    document = { fileName: file.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 240), contentType: file.type, fileSize: file.size, contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64") };
  }
  return getDatabase().transaction(async tx => {
    const [found] = await tx.select().from(offlineSales).where(eq(offlineSales.id, saleId)).for("update");
    const sale = checkOwner(found, actor);
    if (sale.updatedAt.toISOString() !== expectedVersion) fail("This order changed while you were editing. Close and reopen it to use the latest version.", 409);
    if (sale.deliveryStatus !== "packing") fail("Only orders still being prepared can be edited or cancelled.", 409);
    const issued = await tx.select({ id: inventoryTransactions.id }).from(inventoryTransactions).where(eq(inventoryTransactions.idempotencyKey, `offline-sale-dispatch:${saleId}`)).limit(1);
    if (issued.length) fail("Stock has already been issued. Ask Warehouse to record a return.", 409);
    if (!sale.warehouseLocationId || sale.lines.some(line => !line.productId)) fail("This order has incomplete stock mappings. Ask Warehouse to reconcile it.");
    const oldDocuments = await tx.select({ id: offlineSaleDocuments.id, fileName: offlineSaleDocuments.fileName, createdAt: offlineSaleDocuments.createdAt }).from(offlineSaleDocuments).where(and(eq(offlineSaleDocuments.offlineSaleId, saleId), eq(offlineSaleDocuments.kind, "invoice"))).orderBy(asc(offlineSaleDocuments.createdAt));
    const collections = await tx.select({ amount: offlineSaleCollections.amountPaisa }).from(offlineSaleCollections).where(eq(offlineSaleCollections.offlineSaleId, saleId));
    const collected = collections.reduce((sum, row) => sum + row.amount, 0);
    let changes: Partial<typeof offlineSales.$inferInsert> = { deliveryStatus: "cancelled", expectedNextPaymentDate: null };
    if (action === "edit") {
      let totals: ReturnType<typeof amendmentTotals>;
      try { totals = amendmentTotals(body.lines as AmendmentLine[]); } catch (error) { return fail(error instanceof Error ? error.message : "Invalid invoice lines."); }
      if (totals.totalAmountPaisa < collected) fail("The corrected total cannot be below payments already recorded.");
      const catalog = await tx.select({ id: products.id, name: products.name, sku: products.sku, active: products.active }).from(products).where(inArray(products.id, totals.lines.map(line => line.productId)));
      const lines = totals.lines.map(line => {
        const product = catalog.find(product => product.id === line.productId);
        if (!product || (!product.active && !sale.lines.some(old => old.productId === line.productId))) return fail("Choose an active catalog product.");
        return { ...line, productName: product.name, sku: product.sku };
      });
      const billingAddress = clean(body.billingAddress, "Billing address", 5, 500);
      const gstNumber = clean(body.gstNumber ?? "", "GSTIN", 0, 15).toUpperCase();
      if (gstNumber && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstNumber)) fail("Enter a valid GSTIN or leave it blank.");
      changes = { ...totals, lines, saleDate: new Date(`${date(body.saleDate, "Invoice date")}T12:00:00+05:30`), billingInvoiceNumber: normalizeInvoiceNumber(clean(body.billingInvoiceNumber, "Invoice number", 2, 100)), customerName: clean(body.customerName, "Customer name", 2, 160), customerCompanyName: clean(body.customerCompanyName ?? "", "Company name", 0, 160) || null, customerContact: clean(body.customerContact ?? "", "Contact", 0, 80) || null, billingAddress, shippingSameAsBilling: body.shippingSameAsBilling === true, shippingAddress: body.shippingSameAsBilling === true ? billingAddress : clean(body.shippingAddress, "Shipping address", 5, 500), gstNumber: gstNumber || null, notes: clean(body.notes ?? "", "Notes", 0, 1000) || null, requestedDispatchDate: body.requestedDispatchDate ? date(body.requestedDispatchDate, "Requested dispatch date") : null };
    }
    const newLines = action === "edit" ? changes.lines! : [];
    const oldQuantities = new Map<string, number>();
    for (const line of sale.lines) oldQuantities.set(line.productId!, (oldQuantities.get(line.productId!) ?? 0) + line.quantity);
    const newQuantities = new Map(newLines.map(line => [line.productId!, line.quantity]));
    const ids = [...new Set([...oldQuantities.keys(), ...newQuantities.keys()])];
    const balances = await tx.select().from(inventoryBalances).where(and(inArray(inventoryBalances.productId, ids), eq(inventoryBalances.warehouseLocationId, sale.warehouseLocationId!), eq(inventoryBalances.bucket, "retail"))).orderBy(inventoryBalances.productId).for("update");
    for (const id of ids) {
      const balance = balances.find(row => row.productId === id);
      if (!balance) fail("Retail stock record is missing for a product. Ask Warehouse to receive or reconcile stock.");
      let reserved: number;
      try { reserved = reservationAfterCorrection(balance!.onHand, balance!.reserved, oldQuantities.get(id) ?? 0, newQuantities.get(id) ?? 0); } catch (error) { return fail(error instanceof Error ? error.message : "Stock update failed."); }
      await tx.update(inventoryBalances).set({ reserved, version: sql`${inventoryBalances.version} + 1`, updatedAt: new Date() }).where(eq(inventoryBalances.id, balance!.id));
    }
    const stockRotationTransactionId = await rebalanceOfflineStock(tx, {
      productIds: ids,
      warehouseLocationId: sale.warehouseLocationId!,
      actorUsername: actor.username,
      idempotencyKey: `offline-sale-amendment-rotation:${sale.id}:${sale.updatedAt.toISOString()}`,
      reason: action === "cancel"
        ? "Cancelled sales order released its reservation; remaining free stock was rebalanced 40/40/20."
        : "Sales order quantities changed; remaining free stock was rebalanced 40/40/20.",
      referenceId: sale.billingInvoiceNumber ?? sale.saleNumber,
    });
    const newDocuments = [...oldDocuments];
    if (action === "edit" && document) {
      const [saved] = await tx.insert(offlineSaleDocuments).values({ ...document, offlineSaleId: saleId, kind: "invoice", uploadedBy: actor.username }).returning({ id: offlineSaleDocuments.id, fileName: offlineSaleDocuments.fileName, createdAt: offlineSaleDocuments.createdAt });
      newDocuments.push(saved);
    }
    const [updated] = await tx.update(offlineSales).set({ ...changes, updatedAt: new Date() }).where(eq(offlineSales.id, saleId)).returning();
    await tx.insert(auditEvents).values({ actorUsername: actor.username, action: action === "edit" ? actions[0] : actions[1], entityType: "offline_sale", entityId: saleId, reason, previousValue: snapshot({ ...sale, invoiceDocuments: oldDocuments, collectedAmountPaisa: collected }), newValue: snapshot({ ...updated, invoiceDocuments: newDocuments, collectedAmountPaisa: collected }) });
    return { ok: true, stockRotationTransactionId };
  });
}
