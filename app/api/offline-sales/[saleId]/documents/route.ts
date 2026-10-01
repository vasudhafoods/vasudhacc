import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { offlineSaleDocuments, offlineSales } from "@/db/schema";
import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_ACCESS = ["admin", "management", "retail_sales"] as const;
const DOCUMENT_ACCESS = ["admin", "management", "retail_sales", "warehouse_manager", "warehouse_staff"] as const;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export async function GET(_request: Request, { params }: { params: Promise<{ saleId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, DOCUMENT_ACCESS)) return Response.json({ error: { message: "This account cannot view sales documents." } }, { status: 403 });
  const { saleId } = await params;
  const db = getDatabase();
  const rows = await db.select({ id: offlineSaleDocuments.id, kind: offlineSaleDocuments.kind, fileName: offlineSaleDocuments.fileName, contentType: offlineSaleDocuments.contentType, createdAt: offlineSaleDocuments.createdAt }).from(offlineSaleDocuments).where(eq(offlineSaleDocuments.offlineSaleId, saleId));
  return Response.json({ files: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), url: `/api/offline-sales/${saleId}/documents/${row.id}` })) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ saleId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, SALES_ACCESS)) return Response.json({ error: { message: "This account cannot upload sales documents." } }, { status: 403 });
  try {
    const { saleId } = await params;
    const db = getDatabase();
    const [sale] = await db.select({ id: offlineSales.id }).from(offlineSales).where(eq(offlineSales.id, saleId)).limit(1);
    if (!sale) return Response.json({ error: { message: "Sales order not found." } }, { status: 404 });
    const form = await request.formData();
    const kind = String(form.get("kind") ?? "");
    if (kind !== "invoice" && kind !== "payment_proof") return Response.json({ error: { message: "Choose an invoice or payment proof document." } }, { status: 400 });
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 1) return Response.json({ error: { message: "Choose a file to upload." } }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return Response.json({ error: { message: "Each file must be 3 MB or less." } }, { status: 413 });
    if (!ALLOWED_TYPES.has(file.type)) return Response.json({ error: { message: "Use a PDF, JPG, PNG, or WebP file." } }, { status: 400 });
    const count = await db.select({ id: offlineSaleDocuments.id }).from(offlineSaleDocuments).where(and(eq(offlineSaleDocuments.offlineSaleId, saleId), eq(offlineSaleDocuments.kind, kind)));
    if (kind === "invoice" && count.length > 0) return Response.json({ error: { message: "An invoice copy is already attached to this order." } }, { status: 409 });
    if (count.length >= 5) return Response.json({ error: { message: "Up to five payment proofs can be attached to an order." } }, { status: 413 });
    const [saved] = await db.insert(offlineSaleDocuments).values({ offlineSaleId: saleId, kind, fileName: file.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 240) || "sales-document", contentType: file.type, fileSize: file.size, contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64"), uploadedBy: session.username }).returning({ id: offlineSaleDocuments.id });
    return Response.json({ ok: true, id: saved.id }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: { message: error instanceof Error ? error.message : "Sales document could not be uploaded." } }, { status: 500 });
  }
}
