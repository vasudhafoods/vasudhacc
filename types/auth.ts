export const DASHBOARD_ROLES = [
  "admin",
  "management",
  "warehouse_manager",
  "warehouse_staff",
  "retail_sales",
] as const;

export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

export interface AuthenticatedUser {
  userId: string | null;
  username: string;
  displayName: string;
  role: DashboardRole;
}

export function isDashboardRole(value: unknown): value is DashboardRole {
  return typeof value === "string" && DASHBOARD_ROLES.includes(value as DashboardRole);
}

export function isWarehouseRole(role: DashboardRole): boolean {
  return role === "warehouse_manager" || role === "warehouse_staff";
}

export function isManagementRole(role: DashboardRole): boolean {
  return role === "admin" || role === "management";
}

export function roleLabel(role: DashboardRole): string {
  const labels: Record<DashboardRole, string> = {
    admin: "Administrator",
    management: "Management",
    warehouse_manager: "Warehouse Manager",
    warehouse_staff: "Warehouse Staff",
    retail_sales: "Retail Sales",
  };
  return labels[role];
}
