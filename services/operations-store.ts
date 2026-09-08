import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventorySnapshotRuns, operationsSettings } from "@/db/schema";
import type { OperationsSettings, SnapshotRun } from "@/types/operations";

const SETTINGS_KEY = "inventory";

export const DEFAULT_OPERATIONS_SETTINGS: OperationsSettings = {
  schemaVersion: 1,
  defaultLowStockThreshold: 20,
  leadTimeDays: 14,
  safetyStockDays: 7,
  deadStockDays: 30,
  hideUntrackedByDefault: false,
  productThresholds: {},
  alerts: { emailEnabled: true, whatsappEnabled: false },
  updatedAt: null,
};

export async function readOperationsSettings(): Promise<OperationsSettings> {
  try {
    const [row] = await getDatabase().select({ value: operationsSettings.value })
      .from(operationsSettings).where(eq(operationsSettings.key, SETTINGS_KEY)).limit(1);
    const stored = row?.value;
    if (!stored || stored.schemaVersion !== 1) return DEFAULT_OPERATIONS_SETTINGS;
    return {
      ...DEFAULT_OPERATIONS_SETTINGS,
      ...stored,
      productThresholds: stored.productThresholds ?? {},
      alerts: { ...DEFAULT_OPERATIONS_SETTINGS.alerts, ...stored.alerts },
    };
  } catch {
    return DEFAULT_OPERATIONS_SETTINGS;
  }
}

export async function writeOperationsSettings(settings: OperationsSettings): Promise<void> {
  await getDatabase().insert(operationsSettings).values({
    key: SETTINGS_KEY,
    value: settings,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: operationsSettings.key,
    set: { value: settings, updatedAt: new Date() },
  });
}

export async function writeSnapshotRun(run: SnapshotRun): Promise<void> {
  await getDatabase().insert(inventorySnapshotRuns).values({
    id: run.id,
    source: run.source,
    status: run.status,
    startedAt: new Date(run.startedAt),
    completedAt: new Date(run.completedAt),
    snapshotDate: run.snapshotDate,
    totalInventory: run.totalInventory,
    totalProducts: run.totalProducts,
    message: run.message,
    alertResults: run.alertResults,
  });
}

export async function readSnapshotRuns(limit = 20): Promise<SnapshotRun[]> {
  try {
    const rows = await getDatabase().select().from(inventorySnapshotRuns)
      .orderBy(desc(inventorySnapshotRuns.startedAt)).limit(Math.min(100, Math.max(limit, 1)));
    return rows.map((row) => ({
      schemaVersion: 1,
      id: row.id,
      source: row.source as SnapshotRun["source"],
      status: row.status as SnapshotRun["status"],
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt.toISOString(),
      snapshotDate: row.snapshotDate,
      totalInventory: row.totalInventory,
      totalProducts: row.totalProducts,
      message: row.message,
      ...(row.alertResults ? { alertResults: row.alertResults } : {}),
    }));
  } catch {
    return [];
  }
}
