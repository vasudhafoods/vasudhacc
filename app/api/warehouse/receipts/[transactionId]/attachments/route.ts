import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventoryReceiptAttachments, inventoryTransactions } from "@/db/schema";
import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 3_500 * 1024;
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { message: "This account cannot upload receipt documents." } }, { status: 403 });
  try {
    const { transactionId } = await params;
    const db = getDatabase();
    const [transaction] = await db.select({ id: inventoryTransactions.id, type: inventoryTransactions.type }).from(inventoryTransactions).where(eq(inventoryTransactions.id, transactionId)).limit(1);
    if (!transaction || transaction.type !== "stock_received") return Response.json({ error: { message: "Receipt transaction not found." } }, { status: 404 });
    const form = await request.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    if (files.length < 1 || files.length > MAX_FILES) return Response.json({ error: { message: `Upload between 1 and ${MAX_FILES} files.` } }, { status: 400 });
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) return Response.json({ error: { message: "Combined file size must be 3.5 MB or less." } }, { status: 413 });
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) return Response.json({ error: { message: `${file.name} exceeds the 3 MB per-file limit.` } }, { status: 413 });
      if (!ALLOWED_TYPES.has(file.type)) return Response.json({ error: { message: `${file.name} is not a supported PDF or image file.` } }, { status: 400 });
    }
    await db.insert(inventoryReceiptAttachments).values(await Promise.all(files.map(async (file) => ({
      transactionId,
      fileName: file.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 240) || "receipt-file",
      contentType: file.type,
      fileSize: file.size,
      contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
      uploadedBy: session.username,
    }))));
    return Response.json({ ok: true, uploaded: files.length }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: { message: error instanceof Error ? error.message : "Receipt files could not be uploaded." } }, { status: 500 });
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { message: "This account cannot view receipt documents." } }, { status: 403 });
  const { transactionId } = await params;
  const rows = await getDatabase().select({ id: inventoryReceiptAttachments.id, fileName: inventoryReceiptAttachments.fileName, contentType: inventoryReceiptAttachments.contentType })
    .from(inventoryReceiptAttachments).where(eq(inventoryReceiptAttachments.transactionId, transactionId));
  return Response.json({ files: rows.map(({ id, fileName, contentType }) => ({ id, fileName, contentType, url: `/api/warehouse/receipts/${transactionId}/attachments/${id}` })) }, { headers: { "Cache-Control": "private, no-store" } });
}
