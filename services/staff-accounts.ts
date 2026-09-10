import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { auditEvents, staffUsers } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { AuthenticatedUser, DashboardRole } from "@/types/auth";

const MANAGED_STAFF_ROLES = ["warehouse_manager", "warehouse_staff", "retail_sales"] as const;
export type ManagedStaffRole = (typeof MANAGED_STAFF_ROLES)[number];

export class StaffAccountError extends Error {
  constructor(readonly code: "INVALID_ACCOUNT" | "USERNAME_EXISTS", message: string) {
    super(message);
    this.name = "StaffAccountError";
  }
}

export interface StaffAccount {
  id: string;
  username: string;
  displayName: string;
  role: ManagedStaffRole;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export async function authenticateStaffAccount(username: string, password: string): Promise<AuthenticatedUser | null> {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername || !password) return null;

  const db = getDatabase();
  const [account] = await db.select({
    id: staffUsers.id,
    username: staffUsers.username,
    displayName: staffUsers.displayName,
    role: staffUsers.role,
    passwordHash: staffUsers.passwordHash,
    active: staffUsers.active,
  }).from(staffUsers).where(eq(staffUsers.username, normalizedUsername)).limit(1);

  if (!account?.active || !account.passwordHash || !await verifyPassword(password, account.passwordHash)) return null;
  await db.update(staffUsers).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(staffUsers.id, account.id));
  return {
    userId: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role as DashboardRole,
  };
}

export async function readActiveStaffIdentity(accountId: string): Promise<AuthenticatedUser | null> {
  const db = getDatabase();
  const [account] = await db.select({
    id: staffUsers.id,
    username: staffUsers.username,
    displayName: staffUsers.displayName,
    role: staffUsers.role,
    active: staffUsers.active,
  }).from(staffUsers).where(eq(staffUsers.id, accountId)).limit(1);
  if (!account?.active) return null;
  return { userId: account.id, username: account.username, displayName: account.displayName, role: account.role as DashboardRole };
}

export async function listStaffAccounts(): Promise<StaffAccount[]> {
  const db = getDatabase();
  const rows = await db.select({
    id: staffUsers.id,
    username: staffUsers.username,
    displayName: staffUsers.displayName,
    role: staffUsers.role,
    active: staffUsers.active,
    lastLoginAt: staffUsers.lastLoginAt,
    createdAt: staffUsers.createdAt,
  }).from(staffUsers)
    .where(inArray(staffUsers.role, [...MANAGED_STAFF_ROLES]))
    .orderBy(desc(staffUsers.active), staffUsers.displayName);

  return rows.map((row) => ({
    ...row,
    role: row.role as StaffAccount["role"],
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createStaffAccount(input: {
  username: string;
  displayName: string;
  password: string;
  role: ManagedStaffRole;
}, actorUsername: string): Promise<StaffAccount> {
  const username = normalizeUsername(input.username);
  const displayName = input.displayName.trim();
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) {
    throw new StaffAccountError("INVALID_ACCOUNT", "Username must be 3–50 characters and use only letters, numbers, dots, dashes, or underscores.");
  }
  if (displayName.length < 2 || displayName.length > 100) {
    throw new StaffAccountError("INVALID_ACCOUNT", "Staff name must be between 2 and 100 characters.");
  }
  if (input.password.length < 12 || !/[A-Za-z]/.test(input.password) || !/\d/.test(input.password)) {
    throw new StaffAccountError("INVALID_ACCOUNT", "Temporary password must be at least 12 characters and include a letter and a number.");
  }
  if (!MANAGED_STAFF_ROLES.includes(input.role)) {
    throw new StaffAccountError("INVALID_ACCOUNT", "A valid staff role is required.");
  }

  const db = getDatabase();
  const existing = await db.select({ id: staffUsers.id }).from(staffUsers).where(eq(staffUsers.username, username)).limit(1);
  if (existing[0]) throw new StaffAccountError("USERNAME_EXISTS", "That username is already in use.");
  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx.insert(staffUsers).values({ username, displayName, passwordHash, role: input.role }).returning({
        id: staffUsers.id,
        username: staffUsers.username,
        displayName: staffUsers.displayName,
        role: staffUsers.role,
        active: staffUsers.active,
        lastLoginAt: staffUsers.lastLoginAt,
        createdAt: staffUsers.createdAt,
      });
      await tx.insert(auditEvents).values({
        actorUsername,
        action: "staff.account_created",
        entityType: "staff_user",
        entityId: account.id,
        newValue: { username, displayName, role: input.role, active: true },
        reason: "Staff workspace access granted by administrator",
      });
      return {
        ...account,
        role: account.role as StaffAccount["role"],
        lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
        createdAt: account.createdAt.toISOString(),
      };
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      throw new StaffAccountError("USERNAME_EXISTS", "That username is already in use.");
    }
    throw error;
  }
}

export async function setStaffAccountActive(accountId: string, active: boolean, actorUsername: string): Promise<void> {
  const db = getDatabase();
  const [existing] = await db.select({ id: staffUsers.id, role: staffUsers.role, active: staffUsers.active })
    .from(staffUsers)
    .where(and(eq(staffUsers.id, accountId), inArray(staffUsers.role, [...MANAGED_STAFF_ROLES])))
    .limit(1);
  if (!existing) throw new StaffAccountError("INVALID_ACCOUNT", "Staff account was not found.");
  await db.transaction(async (tx) => {
    await tx.update(staffUsers).set({ active, updatedAt: new Date() }).where(eq(staffUsers.id, accountId));
    await tx.insert(auditEvents).values({
      actorUsername,
      action: active ? "staff.account_activated" : "staff.account_deactivated",
      entityType: "staff_user",
      entityId: accountId,
      previousValue: { active: existing.active },
      newValue: { active },
      reason: active ? "Staff access restored by administrator" : "Staff access disabled by administrator",
    });
  });
}

export async function resetStaffPassword(accountId: string, password: string, actorUsername: string): Promise<void> {
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new StaffAccountError("INVALID_ACCOUNT", "Temporary password must be at least 12 characters and include a letter and a number.");
  }
  const db = getDatabase();
  const [existing] = await db.select({ id: staffUsers.id, role: staffUsers.role })
    .from(staffUsers)
    .where(and(eq(staffUsers.id, accountId), inArray(staffUsers.role, [...MANAGED_STAFF_ROLES])))
    .limit(1);
  if (!existing) throw new StaffAccountError("INVALID_ACCOUNT", "Staff account was not found.");
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.update(staffUsers).set({ passwordHash, updatedAt: new Date() }).where(eq(staffUsers.id, accountId));
    await tx.insert(auditEvents).values({
      actorUsername,
      action: "staff.password_reset",
      entityType: "staff_user",
      entityId: accountId,
      reason: "Staff password replaced by administrator",
    });
  });
}
