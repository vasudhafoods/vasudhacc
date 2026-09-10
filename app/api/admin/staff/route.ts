import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import {
  createStaffAccount,
  listStaffAccounts,
  resetStaffPassword,
  setStaffAccountActive,
  StaffAccountError,
} from "@/services/staff-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorizeAdmin() {
  const session = await getDashboardSession();
  if (!session) return { response: Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 }) } as const;
  if (!sessionHasRole(session, ["admin"])) return { response: Response.json({ error: { code: "FORBIDDEN", message: "Only an administrator can manage staff accounts." } }, { status: 403 }) } as const;
  return { session } as const;
}

export async function GET() {
  const authorization = await authorizeAdmin();
  if ("response" in authorization) return authorization.response;
  return Response.json({ ok: true, accounts: await listStaffAccounts() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const authorization = await authorizeAdmin();
  if ("response" in authorization) return authorization.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const role = body.role === "warehouse_manager" || body.role === "retail_sales" ? body.role : "warehouse_staff";
    const account = await createStaffAccount({
      username: String(body.username ?? ""),
      displayName: String(body.displayName ?? ""),
      password: String(body.password ?? ""),
      role,
    }, authorization.session.username);
    return Response.json({ ok: true, account }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StaffAccountError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "USERNAME_EXISTS" ? 409 : 400 });
    return Response.json({ error: { code: "STAFF_CREATE_FAILED", message: error instanceof Error ? error.message : "Staff account creation failed." } }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const authorization = await authorizeAdmin();
  if ("response" in authorization) return authorization.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.password === "string") {
      await resetStaffPassword(String(body.accountId ?? ""), body.password, authorization.session.username);
      return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (typeof body.active !== "boolean") return Response.json({ error: { code: "INVALID_ACCOUNT", message: "An active status is required." } }, { status: 400 });
    await setStaffAccountActive(String(body.accountId ?? ""), body.active, authorization.session.username);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StaffAccountError) return Response.json({ error: { code: error.code, message: error.message } }, { status: 400 });
    return Response.json({ error: { code: "STAFF_UPDATE_FAILED", message: error instanceof Error ? error.message : "Staff account update failed." } }, { status: 500 });
  }
}
