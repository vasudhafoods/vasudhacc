import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import {
  auditEvents,
  inventoryTransactionLines,
  inventoryTransactions,
  products,
  shopifyMappings,
  warehouseLocations,
} from "@/db/schema";
import type { WarehouseActivity, WarehouseProductOption, WarehouseWorkspaceData } from "@/types/warehouse";

export class WarehouseProductError extends Error {
  constructor(readonly code: "INVALID_PRODUCT" | "SKU_EXISTS" | "BARCODE_EXISTS", message: string) {
    super(message);
    this.name = "WarehouseProductError";
  }
}

function productAuditActivity(row: typeof auditEvents.$inferSelect): WarehouseActivity {
  const values = row.newValue ?? {};
  const name = typeof values.name === "string" ? values.name : "New product";
  const sku = typeof values.sku === "string" ? values.sku : "SKU not available";
  const packSize = typeof values.packSize === "string" && values.packSize ? values.packSize : null;
  return {
    id: `product-${row.id}`,
    kind: "product_created",
    title: name,
    reference: `Product created · ${sku}`,
    occurredAt: row.createdAt.toISOString(),
    details: packSize ? [`Pack size: ${packSize}`] : [],
  };
}

export async function getWarehouseWorkspaceData(actorUsername: string): Promise<WarehouseWorkspaceData> {
  const db = getDatabase();
  const [productRows, mappingRows, locationRows, transactionRows, productAuditRows] = await Promise.all([
    db.select({ id: products.id, sku: products.sku, name: products.name, packSize: products.packSize })
      .from(products).where(eq(products.active, true)).orderBy(products.name, products.sku),
    db.select({ id: shopifyMappings.id, productId: shopifyMappings.productId })
      .from(shopifyMappings).where(eq(shopifyMappings.status, "mapped")),
    db.select({ id: warehouseLocations.id, code: warehouseLocations.code, name: warehouseLocations.name })
      .from(warehouseLocations).where(eq(warehouseLocations.active, true)).orderBy(warehouseLocations.name),
    db.select({
      id: inventoryTransactions.id,
      transactionNumber: inventoryTransactions.transactionNumber,
      occurredAt: inventoryTransactions.occurredAt,
      metadata: inventoryTransactions.metadata,
    }).from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.actorUsername, actorUsername), eq(inventoryTransactions.type, "stock_received")))
      .orderBy(desc(inventoryTransactions.occurredAt)).limit(12),
    db.select().from(auditEvents)
      .where(and(eq(auditEvents.actorUsername, actorUsername), eq(auditEvents.action, "product.created")))
      .orderBy(desc(auditEvents.createdAt)).limit(12),
  ]);

  const mappingByProduct = new Map<string, string>();
  for (const mapping of mappingRows) if (!mappingByProduct.has(mapping.productId)) mappingByProduct.set(mapping.productId, mapping.id);
  const productOptions: WarehouseProductOption[] = productRows.map((product) => ({
    ...product,
    shopifyMappingId: mappingByProduct.get(product.id) ?? null,
  }));

  const receiptActivities: WarehouseActivity[] = [];
  if (transactionRows.length) {
    const lines = await db.select({
      transactionId: inventoryTransactionLines.transactionId,
      bucket: inventoryTransactionLines.bucket,
      quantity: inventoryTransactionLines.quantityDelta,
      productName: products.name,
      sku: products.sku,
      locationName: warehouseLocations.name,
    }).from(inventoryTransactionLines)
      .innerJoin(products, eq(inventoryTransactionLines.productId, products.id))
      .innerJoin(warehouseLocations, eq(inventoryTransactionLines.warehouseLocationId, warehouseLocations.id))
      .where(inArray(inventoryTransactionLines.transactionId, transactionRows.map((transaction) => transaction.id)));
    const linesByTransaction = new Map<string, typeof lines>();
    for (const line of lines) {
      const existing = linesByTransaction.get(line.transactionId) ?? [];
      existing.push(line);
      linesByTransaction.set(line.transactionId, existing);
    }
    for (const transaction of transactionRows) {
      const transactionLines = linesByTransaction.get(transaction.id) ?? [];
      const first = transactionLines[0];
      const batchNumber = typeof transaction.metadata.batchNumber === "string" ? transaction.metadata.batchNumber : null;
      receiptActivities.push({
        id: `receipt-${transaction.id}`,
        kind: "stock_received",
        title: first?.productName ?? "Stock receipt",
        reference: transaction.transactionNumber,
        occurredAt: transaction.occurredAt.toISOString(),
        details: [
          first ? `SKU: ${first.sku}` : "",
          first ? `Location: ${first.locationName}` : "",
          batchNumber ? `Batch: ${batchNumber}` : "",
          ...transactionLines.map((line) => `${line.bucket[0].toUpperCase()}${line.bucket.slice(1)}: +${line.quantity}`),
        ].filter(Boolean),
      });
    }
  }

  const activities = [...receiptActivities, ...productAuditRows.map(productAuditActivity)]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, 20);

  return { products: productOptions, locations: locationRows, activities };
}

export async function createWarehouseProduct(input: {
  sku: string;
  name: string;
  packSize?: string;
  barcode?: string;
}, actorUsername: string): Promise<WarehouseProductOption> {
  const sku = input.sku.trim().toUpperCase();
  const name = input.name.trim();
  const packSize = input.packSize?.trim() || null;
  const barcode = input.barcode?.trim() || null;
  if (!/^[A-Z0-9][A-Z0-9._/-]{1,59}$/.test(sku)) {
    throw new WarehouseProductError("INVALID_PRODUCT", "SKU must be 2–60 characters and use only letters, numbers, dots, dashes, slashes, or underscores.");
  }
  if (name.length < 2 || name.length > 200) throw new WarehouseProductError("INVALID_PRODUCT", "Product name must be between 2 and 200 characters.");
  if (packSize && packSize.length > 100) throw new WarehouseProductError("INVALID_PRODUCT", "Pack size must be 100 characters or fewer.");
  if (barcode && !/^[A-Za-z0-9._/-]{4,100}$/.test(barcode)) throw new WarehouseProductError("INVALID_PRODUCT", "Barcode must contain 4–100 letters, numbers, dots, dashes, slashes, or underscores.");

  const db = getDatabase();
  const existingSku = await db.select({ id: products.id }).from(products).where(eq(products.sku, sku)).limit(1);
  if (existingSku[0]) throw new WarehouseProductError("SKU_EXISTS", "A product with this SKU already exists.");
  if (barcode) {
    const existingBarcode = await db.select({ id: products.id }).from(products).where(eq(products.barcode, barcode)).limit(1);
    if (existingBarcode[0]) throw new WarehouseProductError("BARCODE_EXISTS", "A product with this barcode already exists.");
  }

  try {
    return await db.transaction(async (tx) => {
      const [product] = await tx.insert(products).values({ sku, name, packSize, barcode }).returning({
        id: products.id,
        sku: products.sku,
        name: products.name,
        packSize: products.packSize,
      });
      await tx.insert(auditEvents).values({
        actorUsername,
        action: "product.created",
        entityType: "product",
        entityId: product.id,
        newValue: { sku, name, packSize, barcode, active: true },
        reason: "New product entered by warehouse staff",
      });
      return { ...product, shopifyMappingId: null };
    });
  } catch (error) {
    if (typeof error === "object" && error && "constraint_name" in error) {
      if (error.constraint_name === "products_sku_unique") throw new WarehouseProductError("SKU_EXISTS", "A product with this SKU already exists.");
      if (error.constraint_name === "products_barcode_unique") throw new WarehouseProductError("BARCODE_EXISTS", "A product with this barcode already exists.");
    }
    throw error;
  }
}
