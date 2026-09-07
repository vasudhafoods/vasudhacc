import { getDashboardSession } from "@/lib/auth/authorization";
import { getWarehouseFoundationStatus } from "@/services/warehouse-foundation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!await getDashboardSession()) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  const status = await getWarehouseFoundationStatus();
  return Response.json(status, { status: status.configured ? 200 : 503, headers: { "Cache-Control": "private, no-store" } });
}
