import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { OfflineSalesError, setOfflineSalePaymentReminder } from "@/services/offline-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_ACCESS = ["admin", "management", "retail_sales"] as const;

export async function PATCH(request: Request, context: { params: Promise<{ saleId: string }> }) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, SALES_ACCESS)) return Response.json({ error: { message: "This account cannot update payment reminders." } }, { status: 403 });
  try {
    const body = await request.json() as { reminderDate?: unknown };
    const { saleId } = await context.params;
    const sale = await setOfflineSalePaymentReminder({ saleId, reminderDate: String(body.reminderDate ?? ""), actorUsername: session.username });
    return Response.json({ ok: true, sale }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OfflineSalesError) return Response.json({ error: { message: error.message } }, { status: error.code === "NOT_FOUND" ? 404 : 400 });
    return Response.json({ error: { message: error instanceof Error ? error.message : "Payment reminder could not be saved." } }, { status: 500 });
  }
}
