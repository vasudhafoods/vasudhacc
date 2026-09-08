import { getDashboardSession } from "@/lib/auth/authorization";
import { DEFAULT_OPERATIONS_SETTINGS, readOperationsSettings, writeOperationsSettings } from "@/services/operations-store";
import type { OperationsSettings } from "@/types/operations";
import { isManagementRole } from "@/types/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function integer(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: "Management access is required." }, { status: 403 });
  return Response.json(await readOperationsSettings(), { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (!isManagementRole(session.role)) return Response.json({ error: "Management access is required." }, { status: 403 });
  const previous = await readOperationsSettings();
  const body = await request.json() as Partial<OperationsSettings>;
  const rawThresholds = body.productThresholds && typeof body.productThresholds === "object" ? body.productThresholds : previous.productThresholds;
  const productThresholds = Object.fromEntries(Object.entries(rawThresholds).filter(([key, value]) => key.startsWith("gid://shopify/Product/") && Number.isFinite(Number(value))).map(([key, value]) => [key, integer(value, previous.defaultLowStockThreshold, 0, 1_000_000)]));
  const settings: OperationsSettings = {
    ...DEFAULT_OPERATIONS_SETTINGS,
    ...previous,
    defaultLowStockThreshold: integer(body.defaultLowStockThreshold, previous.defaultLowStockThreshold, 0, 1_000_000),
    leadTimeDays: integer(body.leadTimeDays, previous.leadTimeDays, 1, 365),
    safetyStockDays: integer(body.safetyStockDays, previous.safetyStockDays, 0, 365),
    deadStockDays: integer(body.deadStockDays, previous.deadStockDays, 7, 365),
    hideUntrackedByDefault: Boolean(body.hideUntrackedByDefault),
    productThresholds,
    alerts: { emailEnabled: Boolean(body.alerts?.emailEnabled), whatsappEnabled: Boolean(body.alerts?.whatsappEnabled) },
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  await writeOperationsSettings(settings);
  return Response.json(settings, { headers: { "Cache-Control": "private, no-store" } });
}
