import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authenticateStaffAccount, readActiveStaffIdentity } from "@/services/staff-accounts";
import type { AuthenticatedUser, DashboardRole } from "@/types/auth";
import { isManagementRole, isRetailSalesRole, isWarehouseRole } from "@/types/auth";
import { DASHBOARD_SESSION_COOKIE, isSessionConfigurationValid, readDashboardSession } from "./session";

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function isDashboardAuthConfigured(): boolean {
  return isSessionConfigurationValid();
}

export async function authenticateDashboardCredentials(username: string, password: string): Promise<AuthenticatedUser | null> {
  const expectedUsername = process.env.DASHBOARD_USERNAME?.trim() ?? "";
  const expectedPassword = process.env.DASHBOARD_PASSWORD ?? "";
  if (!isDashboardAuthConfigured()) return null;
  if (expectedUsername && expectedPassword.length >= 12 && safeEqual(username, expectedUsername) && safeEqual(password, expectedPassword)) {
    return { userId: null, username: expectedUsername, displayName: "Vasudha Admin", role: "admin" };
  }
  try {
    return await authenticateStaffAccount(username, password);
  } catch {
    return null;
  }
}

export async function getDashboardSession() {
  const token = (await cookies()).get(DASHBOARD_SESSION_COOKIE)?.value;
  const session = await readDashboardSession(token);
  if (!session?.userId) return session;
  try {
    const identity = await readActiveStaffIdentity(session.userId);
    if (!identity || identity.username !== session.username) return null;
    return { ...session, ...identity };
  } catch {
    return null;
  }
}

export async function requireDashboardSession() {
  const session = await getDashboardSession();
  if (!session) redirect("/login");
  if (!isManagementRole(session.role)) redirect(isWarehouseRole(session.role) ? "/warehouse" : "/login?error=access");
  return session;
}

export async function requireWarehouseSession() {
  const session = await getDashboardSession();
  if (!session) redirect("/login");
  if (!isManagementRole(session.role) && !isWarehouseRole(session.role)) redirect("/login?error=access");
  return session;
}

export async function requireSalesSession() {
  const session = await getDashboardSession();
  if (!session) redirect("/login");
  if (!isManagementRole(session.role) && !isRetailSalesRole(session.role)) redirect(isWarehouseRole(session.role) ? "/warehouse" : "/login?error=access");
  return session;
}

export function sessionHasRole(session: { role: DashboardRole } | null, allowed: readonly DashboardRole[]): boolean {
  return Boolean(session && allowed.includes(session.role));
}
