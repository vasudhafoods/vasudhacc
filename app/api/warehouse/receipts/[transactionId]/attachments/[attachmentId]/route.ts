import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventoryReceiptAttachments } from "@/db/schema";
import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

export async function GET(_request: Request, { params }: { params: Promise<{ transactionId: string; attachmentId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { message: "This account cannot view receipt documents." } }, { status: 403 });
  const { transactionId, attachmentId } = await params;
  const [file] = await getDatabase().select().from(inventoryReceiptAttachments).where(and(eq(inventoryReceiptAttachments.id, attachmentId), eq(inventoryReceiptAttachments.transactionId, transactionId))).limit(1);
  if (!file) return Response.json({ error: { message: "Receipt file not found." } }, { status: 404 });
  return new Response(Buffer.from(file.contentBase64, "base64"), { headers: { "Content-Type": file.contentType, "Content-Length": String(file.fileSize), "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
