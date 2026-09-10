import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { createOfflineSale, OfflineSalesError } from "@/services/offline-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_ACCESS = ["admin", "management", "retail_sales"] as const;

function rupeesToPaisa(value: unknown): number {
  const source = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) return Number.NaN;
  return Math.round(Number(source) * 100);
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, SALES_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot record offline sales." } }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const customerType = body.customerType === "b2b" ? "b2b" : "retail";
    const result = await createOfflineSale({
      saleDate: String(body.saleDate ?? ""),
      customerName: String(body.customerName ?? ""),
      customerContact: body.customerContact ? String(body.customerContact) : undefined,
      customerType,
      isNewB2bCustomer: Boolean(body.isNewB2bCustomer),
      totalAmountPaisa: rupeesToPaisa(body.totalAmount),
      initialCollectionPaisa: body.initialCollection === "" || body.initialCollection === undefined ? 0 : rupeesToPaisa(body.initialCollection),
      reference: body.reference ? String(body.reference) : undefined,
      notes: body.notes ? String(body.notes) : undefined,
      actorUsername: session.username,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
    });
    return Response.json({ ok: true, result }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OfflineSalesError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    return Response.json({ error: { code: "OFFLINE_SALE_FAILED", message: error instanceof Error ? error.message : "Offline sale could not be saved." } }, { status: 500 });
  }
}
