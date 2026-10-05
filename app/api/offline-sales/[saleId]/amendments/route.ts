import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { amendOrder, readOrderAmendments, OrderAmendmentError } from "@/services/order-amendments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ saleId: string }> };
async function handle(request: Request, context: Context, write: boolean) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication required." } }, { status: 401 });
  if (!sessionHasRole(session, ["admin", "management", "retail_sales"])) return Response.json({ error: { message: "Sales access required." } }, { status: 403 });
  const { saleId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saleId)) return Response.json({ error: { message: "Invalid order." } }, { status: 400 });
  try {
    if (!write) return Response.json(await readOrderAmendments(saleId, session), { headers: { "Cache-Control": "private, no-store" } });
    const form = await request.formData();
    const body = JSON.parse(String(form.get("data"))) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OrderAmendmentError("Invalid correction.");
    const file = form.get("invoice");
    return Response.json(await amendOrder(saleId, session, body, file instanceof File && file.size ? file : undefined));
  } catch (error) {
    const duplicate = typeof error === "object" && error && "code" in error && error.code === "23505";
    return Response.json({ error: { message: error instanceof OrderAmendmentError ? error.message : duplicate ? "That invoice number is already used by another order." : error instanceof SyntaxError ? "Invalid correction data." : "Unable to save or load this order. Please refresh and try again." } }, { status: error instanceof OrderAmendmentError ? error.status : duplicate ? 409 : error instanceof SyntaxError ? 400 : 500 });
  }
}
export async function GET(request: Request, context: Context) { return handle(request, context, false); }
export async function POST(request: Request, context: Context) { return handle(request, context, true); }
