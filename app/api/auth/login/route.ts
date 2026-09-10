import { NextResponse } from "next/server";
import { createDashboardSession, DASHBOARD_SESSION_COOKIE, DASHBOARD_SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session";
import { authenticateDashboardCredentials, isDashboardAuthConfigured } from "@/lib/auth/authorization";
import { isManagementRole, isRetailSalesRole, isWarehouseRole } from "@/types/auth";

export async function POST(request: Request) {
  const formData = await request.formData();
  const username = String(formData.get("username") ?? "").trim().slice(0, 200);
  const password = String(formData.get("password") ?? "").slice(0, 500);
  const portal = formData.get("portal") === "warehouse" ? "warehouse" : "admin";
  const loginUrl = (error: string) => new URL(`/login?error=${error}&portal=${portal}`, request.url);

  if (!isDashboardAuthConfigured()) {
    return NextResponse.redirect(loginUrl("configuration"), 303);
  }
  const user = await authenticateDashboardCredentials(username, password);
  const portalMatchesRole = user && (portal === "warehouse" ? isWarehouseRole(user.role) || isRetailSalesRole(user.role) : isManagementRole(user.role));
  if (!user || !portalMatchesRole) {
    return NextResponse.redirect(loginUrl("credentials"), 303);
  }

  const response = NextResponse.redirect(new URL(isWarehouseRole(user.role) ? "/warehouse" : isRetailSalesRole(user.role) ? "/sales" : "/", request.url), 303);
  response.cookies.set(DASHBOARD_SESSION_COOKIE, await createDashboardSession(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: DASHBOARD_SESSION_MAX_AGE_SECONDS,
    priority: "high",
  });
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}
