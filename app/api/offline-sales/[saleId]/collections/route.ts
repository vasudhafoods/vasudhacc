import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { OfflineSalesError, recordOfflineSaleCollection } from "@/services/offline-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_ACCESS = ["admin", "management", "retail_sales"] as const;

function rupeesToPaisa(value: unknown): number {
  const source = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) return Number.NaN;
  return Math.round(Number(source) * 100);
}

export async function POST(request: Request, context: { params: Promise<{ saleId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, SALES_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot record collections." } }, { status: 403 });
  try {
    const multipart = request.headers.get("content-type")?.includes("multipart/form-data");
    let proof: { fileName: string; contentType: string; fileSize: number; contentBase64: string } | undefined;
    let body: Record<string, unknown>;
    if (multipart) {
      const form = await request.formData();
      body = Object.fromEntries(form.entries());
      const file = form.get("proof");
      if (!(file instanceof File) || file.size < 1 || file.size > 3 * 1024 * 1024 || !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new OfflineSalesError("INVALID_COLLECTION", "Upload payment proof as PDF, JPG, PNG, or WebP, up to 3 MB.");
      proof = { fileName: file.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 240), contentType: file.type, fileSize: file.size, contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64") };
      body.paymentProofFileName = proof.fileName;
    } else body = await request.json() as Record<string, unknown>;
    const { saleId } = await context.params;
    const result = await recordOfflineSaleCollection({
      saleId,
      proof,
      ownOrdersOnly: session.role === "retail_sales",
      amountPaisa: rupeesToPaisa(body.amount),
      reference: body.reference ? String(body.reference) : undefined,
      notes: body.notes ? String(body.notes) : undefined,
      paymentMode: String(body.paymentMode ?? ""),
      paymentTransactionId: body.paymentTransactionId ? String(body.paymentTransactionId) : undefined,
      paymentReceiverName: String(body.paymentReceiverName ?? ""),
      paymentProofFileName: String(body.paymentProofFileName ?? ""),
      expectedNextPaymentDate: body.expectedNextPaymentDate ? String(body.expectedNextPaymentDate) : undefined,
      actorUsername: session.username,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
    });
    return Response.json({ ok: true, result }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OfflineSalesError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    return Response.json({ error: { code: "OFFLINE_COLLECTION_FAILED", message: error instanceof Error ? error.message : "Collection could not be saved." } }, { status: 500 });
  }
}
