import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { createOfflineSale, OfflineSalesError } from "@/services/offline-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_ACCESS = ["admin", "management", "retail_sales"] as const;

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, SALES_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot record offline sales." } }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const result = await createOfflineSale({ saleDate: String(body.saleDate ?? ""), billingInvoiceNumber: String(body.billingInvoiceNumber ?? ""), invoiceFileName: String(body.invoiceFileName ?? ""), customerName: String(body.customerName ?? ""), customerCompanyName: body.customerCompanyName ? String(body.customerCompanyName) : undefined, customerContact: body.customerContact ? String(body.customerContact) : undefined, billingAddress: String(body.billingAddress ?? ""), shippingAddress: body.shippingAddress ? String(body.shippingAddress) : undefined, shippingSameAsBilling: Boolean(body.shippingSameAsBilling), gstNumber: body.gstNumber ? String(body.gstNumber) : undefined, customerType: body.customerType === "b2b" ? "b2b" : "retail", isNewB2bCustomer: Boolean(body.isNewB2bCustomer), initialCollectionPaisa: Math.round(Number(body.initialCollectionPaisa ?? 0)), additionalDiscountPaisa: Math.round(Number(body.additionalDiscountPaisa ?? 0)), paymentMode: body.paymentMode ? String(body.paymentMode) : undefined, paymentTransactionId: body.paymentTransactionId ? String(body.paymentTransactionId) : undefined, paymentReceiverName: body.paymentReceiverName ? String(body.paymentReceiverName) : undefined, paymentProofFileName: body.paymentProofFileName ? String(body.paymentProofFileName) : undefined, expectedNextPaymentDate: body.expectedNextPaymentDate ? String(body.expectedNextPaymentDate) : undefined, warehouseLocationId: String(body.warehouseLocationId ?? ""), reference: body.reference ? String(body.reference) : undefined, notes: body.notes ? String(body.notes) : undefined, actorUsername: session.username, idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "", orderType: typeof body.orderType === "string" ? body.orderType : "retail", location: typeof body.location === "string" ? body.location : undefined, deliveryStatus: "packing", lines: Array.isArray(body.lines) ? body.lines as { productId: string; productName: string; sku: string; quantity: number; unitPricePaisa: number; gstRateBps: number; discountPaisa: number }[] : [] });
    return Response.json({ ok: true, result }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OfflineSalesError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    return Response.json({ error: { code: "SALE_FAILED", message: error instanceof Error ? error.message : "Offline sale could not be saved." } }, { status: 500 });
  }
}
