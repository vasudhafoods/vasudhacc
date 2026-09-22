import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;

export async function POST() {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot dispatch retail stock." } }, { status: 403 });
  return Response.json({ error: { code: "RETAIL_DISPATCH_CLOSED", message: "Retail dispatches are no longer recorded." } }, { status: 410 });
}
