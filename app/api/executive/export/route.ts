import { getDashboardSession } from "@/lib/auth/authorization";
import { buildExecutiveExcel } from "@/lib/executive/export";
import { getExecutiveDashboard } from "@/services/executive-dashboard";
import { isManagementRole } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: { code: "FORBIDDEN", message: "Management access is required." } }, { status: 403 });
  try {
    const data = await getExecutiveDashboard();
    const workbook = buildExecutiveExcel(data);
    return new Response(workbook, {
      headers: {
        "Content-Type": "application/vnd.ms-excel; charset=utf-8",
        "Content-Disposition": `attachment; filename="vasudha-ceo-report-${data.generatedAt.slice(0, 10)}.xls"`,
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    return Response.json({ error: { code: "EXECUTIVE_EXPORT_FAILED", message: error instanceof Error ? error.message : "Executive report could not be generated." } }, { status: 500 });
  }
}
