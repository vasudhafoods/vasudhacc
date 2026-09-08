import { getDashboardSession } from "@/lib/auth/authorization";
import { getWarehouseFoundationStatus } from "@/services/warehouse-foundation";
import { isManagementRole } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: { code: "FORBIDDEN", message: "Management access is required." } }, { status: 403 });
  const status = await getWarehouseFoundationStatus();
  return Response.json(status, { status: status.configured ? 200 : 503, headers: { "Cache-Control": "private, no-store" } });
}
