import { getDashboardSession } from "@/lib/auth/authorization";
import { captureInventorySnapshot } from "@/services/snapshot-capture";
import { isManagementRole } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: "Management access is required." }, { status: 403 });
  try {
    const result = await captureInventorySnapshot("manual");
    return Response.json({ ok: true, snapshot: result.snapshot, run: result.run }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Snapshot failed." }, { status: 500 });
  }
}
