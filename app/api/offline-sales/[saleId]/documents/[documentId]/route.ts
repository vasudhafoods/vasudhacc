import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { offlineSaleDocuments } from "@/db/schema";
import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCUMENT_ACCESS = ["admin", "management", "retail_sales", "warehouse_manager", "warehouse_staff"] as const;

export async function GET(_request: Request, { params }: { params: Promise<{ saleId: string; documentId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, DOCUMENT_ACCESS)) return Response.json({ error: { message: "This account cannot view sales documents." } }, { status: 403 });
  const { saleId, documentId } = await params;
  const [document] = await getDatabase().select().from(offlineSaleDocuments).where(and(eq(offlineSaleDocuments.id, documentId), eq(offlineSaleDocuments.offlineSaleId, saleId))).limit(1);
  if (!document) return Response.json({ error: { message: "Sales document not found." } }, { status: 404 });
  return new Response(Buffer.from(document.contentBase64, "base64"), { headers: { "Content-Type": document.contentType, "Content-Length": String(document.fileSize), "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.fileName)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
