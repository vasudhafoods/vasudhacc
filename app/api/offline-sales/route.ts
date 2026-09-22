import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_ACCESS = ["admin", "management", "retail_sales"] as const;

export async function POST() {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, SALES_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot record offline sales." } }, { status: 403 });
  return Response.json({ error: { code: "OFFLINE_SALES_CLOSED", message: "Retail and B2B orders are no longer recorded." } }, { status: 410 });
}
