import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { createSalesCustomer, OfflineSalesError } from "@/services/offline-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_ACCESS = ["admin", "management", "retail_sales"] as const;

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, SALES_ACCESS)) return Response.json({ error: { message: "This account cannot create customers." } }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const customer = await createSalesCustomer({ name: String(body.name ?? ""), companyName: body.companyName ? String(body.companyName) : undefined, address: String(body.address ?? ""), phone: String(body.phone ?? ""), gstNumber: body.gstNumber ? String(body.gstNumber) : undefined, actorUsername: session.username });
    return Response.json({ ok: true, customer }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OfflineSalesError) return Response.json({ error: { message: error.message } }, { status: 400 });
    return Response.json({ error: { message: error instanceof Error ? error.message : "Customer could not be saved." } }, { status: 500 });
  }
}
