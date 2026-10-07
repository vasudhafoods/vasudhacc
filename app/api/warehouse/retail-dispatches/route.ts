import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventoryReceiptAttachments, inventoryTransactions } from "@/db/schema";
import { dispatchRetailStock, InventoryCommandError } from "@/services/inventory-ledger";
import { attemptAutomaticShopifySync } from "@/services/shopify-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 3_500 * 1024;
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot dispatch retail stock." } }, { status: 403 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const deliveryDateRaw = String(body.deliveryDate ?? "");
    const deliveryDate = new Date(`${deliveryDateRaw}T12:00:00+05:30`);
    if (Number.isNaN(deliveryDate.getTime())) throw new InventoryCommandError("INVALID_DISPATCH", "Delivery date must be valid.");
    const orderType = String(body.orderType ?? "");
    const deliveryStatus = String(body.deliveryStatus ?? "");
    if (!( ["retail", "sample", "inhand", "other"] as string[]).includes(orderType)) throw new InventoryCommandError("INVALID_DISPATCH", "Select a valid order type.");
    if (!( ["packing", "shipped", "dispatched", "delivered"] as string[]).includes(deliveryStatus)) throw new InventoryCommandError("INVALID_DISPATCH", "Select a valid delivery status.");
    const result = await dispatchRetailStock({
      warehouseLocationId: String(body.warehouseLocationId ?? ""),
      destination: String(body.destination ?? ""),
      referenceId: String(body.referenceId ?? ""),
      deliveryDate,
      orderType: orderType as "retail" | "sample" | "inhand" | "other",
      orderValuePaisa: Number(body.orderValuePaisa),
      deliveryStatus: deliveryStatus as "packing" | "shipped" | "dispatched" | "delivered",
      deliveryPartner: String(body.deliveryPartner ?? ""),
      deliveryCostPaisa: Number(body.deliveryCostPaisa),
      lrNumber: String(body.lrNumber ?? ""),
      notes: body.notes ? String(body.notes) : undefined,
      lines: Array.isArray(body.lines) ? body.lines.map((line) => {
        const item = line as Record<string, unknown>;
        return { productId: String(item.productId ?? ""), quantity: Number(item.quantity), unitPricePaisa: Number(item.unitPricePaisa) };
      }) : [],
      actorUsername: session.username,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
    });
    const shopifySync = result.stockTransferTransactionId
      ? await attemptAutomaticShopifySync(result.stockTransferTransactionId, result.shopifySync)
      : "not_required";
    return Response.json({ ok: true, result: { ...result, shopifySync } }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    }
    return Response.json({ error: { code: "DISPATCH_FAILED", message: error instanceof Error ? error.message : "Retail dispatch failed." } }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { message: "This account cannot view delivery documents." } }, { status: 403 });
  const transactionId = new URL(request.url).searchParams.get("transactionId") ?? "";
  const [transaction] = await getDatabase().select({ id: inventoryTransactions.id, type: inventoryTransactions.type }).from(inventoryTransactions).where(eq(inventoryTransactions.id, transactionId)).limit(1);
  if (!transaction || transaction.type !== "retail_issue") return Response.json({ error: { message: "Delivery transaction not found." } }, { status: 404 });
  const rows = await getDatabase().select({ id: inventoryReceiptAttachments.id, fileName: inventoryReceiptAttachments.fileName, contentType: inventoryReceiptAttachments.contentType, uploadedBy: inventoryReceiptAttachments.uploadedBy }).from(inventoryReceiptAttachments).where(eq(inventoryReceiptAttachments.transactionId, transactionId));
  return Response.json({ files: rows.filter((row) => row.fileName.startsWith("[Invoice] ") || row.fileName.startsWith("[Acknowledgement] ")).map((row) => ({ ...row, url: `/api/warehouse/receipts/${transactionId}/attachments/${row.id}` })) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { message: "This account cannot upload delivery documents." } }, { status: 403 });
  try {
    const form = await request.formData();
    const transactionId = String(form.get("transactionId") ?? "");
    const kind = String(form.get("kind") ?? "");
    if (kind !== "Invoice" && kind !== "Acknowledgement") return Response.json({ error: { message: "Select Invoice or Acknowledgement." } }, { status: 400 });
    const [transaction] = await getDatabase().select({ id: inventoryTransactions.id, type: inventoryTransactions.type }).from(inventoryTransactions).where(and(eq(inventoryTransactions.id, transactionId), eq(inventoryTransactions.type, "retail_issue"))).limit(1);
    if (!transaction) return Response.json({ error: { message: "Delivery transaction not found." } }, { status: 404 });
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 1) return Response.json({ error: { message: `Upload a ${kind.toLowerCase()} file.` } }, { status: 400 });
    if (file.size > MAX_FILE_BYTES || file.size > MAX_TOTAL_BYTES) return Response.json({ error: { message: "Each file must be 3 MB or less." } }, { status: 413 });
    if (!ALLOWED_TYPES.has(file.type)) return Response.json({ error: { message: "Use a PDF, JPG, PNG, or WebP file." } }, { status: 400 });
    const db = getDatabase();
    const existing = await db.select({ id: inventoryReceiptAttachments.id, fileSize: inventoryReceiptAttachments.fileSize }).from(inventoryReceiptAttachments).where(eq(inventoryReceiptAttachments.transactionId, transactionId));
    if (existing.length >= 10 || existing.reduce((sum, row) => sum + row.fileSize, 0) + file.size > MAX_TOTAL_BYTES) return Response.json({ error: { message: "Delivery documents exceed the 3.5 MB total file limit." } }, { status: 413 });
    const cleanName = file.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 220) || "delivery-document";
    const [saved] = await db.insert(inventoryReceiptAttachments).values({ transactionId, fileName: `[${kind}] ${cleanName}`, contentType: file.type, fileSize: file.size, contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64"), uploadedBy: session.username }).returning({ id: inventoryReceiptAttachments.id });
    return Response.json({ ok: true, id: saved.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: { message: error instanceof Error ? error.message : "Delivery document upload failed." } }, { status: 500 });
  }
}
