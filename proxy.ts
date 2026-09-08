import { NextResponse, type NextRequest } from "next/server";
import { DASHBOARD_SESSION_COOKIE, readDashboardSession } from "@/lib/auth/session";

const INTERNAL_BEARER_ROUTES = ["/api/cron/inventory", "/api/inventory", "/api/inventory/history"];

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLoginRoute = pathname === "/login" || pathname === "/forgot-password" || pathname.startsWith("/api/auth/");
  const isInternalBearerRoute = INTERNAL_BEARER_ROUTES.includes(pathname);
  if (isInternalBearerRoute) return NextResponse.next();

  const session = await readDashboardSession(request.cookies.get(DASHBOARD_SESSION_COOKIE)?.value);
  if (isLoginRoute) {
    if ((pathname === "/login" || pathname === "/forgot-password") && session) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
