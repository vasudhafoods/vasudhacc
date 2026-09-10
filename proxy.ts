import { NextResponse, type NextRequest } from "next/server";
import { DASHBOARD_SESSION_COOKIE, readDashboardSession } from "@/lib/auth/session";
import { isManagementRole, isWarehouseRole } from "@/types/auth";

const INTERNAL_BEARER_ROUTES = ["/api/cron/inventory", "/api/inventory", "/api/inventory/history"];
const SIGNED_PUBLIC_ROUTES = ["/api/shopify/webhooks"];

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLoginRoute = pathname === "/login" || pathname === "/forgot-password" || pathname.startsWith("/api/auth/");
  const isInternalBearerRoute = INTERNAL_BEARER_ROUTES.includes(pathname);
  if (isInternalBearerRoute) return NextResponse.next();
  if (SIGNED_PUBLIC_ROUTES.includes(pathname)) return NextResponse.next();

  const session = await readDashboardSession(request.cookies.get(DASHBOARD_SESSION_COOKIE)?.value);
  if (isLoginRoute) {
    if ((pathname === "/login" || pathname === "/forgot-password") && session) {
      return NextResponse.redirect(new URL(isWarehouseRole(session.role) ? "/warehouse" : "/", request.url));
    }
    return NextResponse.next();
  }
  if (session && isWarehouseRole(session.role)) {
    if (pathname === "/warehouse" || pathname.startsWith("/warehouse/") || pathname.startsWith("/api/warehouse/")) return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: { code: "FORBIDDEN", message: "Warehouse access is limited to stock intake, retail dispatches, and product creation." } }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/warehouse", request.url));
  }
  if (session && isManagementRole(session.role)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: session ? "FORBIDDEN" : "UNAUTHORIZED", message: session ? "This account cannot access that area." : "Authentication is required." } }, { status: session ? 403 : 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
