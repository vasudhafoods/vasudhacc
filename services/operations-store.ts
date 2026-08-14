import "server-only";
import { get, list, put } from "@vercel/blob";
import type { OperationsSettings, SnapshotRun } from "@/types/operations";

const ACCESS = "private";
const SETTINGS_PATH = "operations/settings.json";
const RUNS_PREFIX = "operations/snapshot-runs";

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

async function readJson<T>(pathname: string): Promise<T | null> {
  try {
    const response = await get(pathname, { access: ACCESS, useCache: false });
    if (!response || response.statusCode !== 200) return null;
    return await new Response(response.stream).json() as T;
  } catch {
    return null;
  }
}

export async function readOperationsSettings(): Promise<OperationsSettings> {
  const stored = await readJson<Partial<OperationsSettings>>(SETTINGS_PATH);
  if (!stored || stored.schemaVersion !== 1) return DEFAULT_OPERATIONS_SETTINGS;
  return {
    ...DEFAULT_OPERATIONS_SETTINGS,
    ...stored,
    productThresholds: stored.productThresholds ?? {},
    alerts: { ...DEFAULT_OPERATIONS_SETTINGS.alerts, ...stored.alerts },
  };
}

export async function writeOperationsSettings(settings: OperationsSettings): Promise<void> {
  await put(SETTINGS_PATH, JSON.stringify(settings, null, 2), {
    access: ACCESS,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

export async function writeSnapshotRun(run: SnapshotRun): Promise<void> {
  await put(`${RUNS_PREFIX}/${run.startedAt.replace(/[:.]/g, "-")}-${run.id}.json`, JSON.stringify(run, null, 2), {
    access: ACCESS,
    allowOverwrite: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

export async function readSnapshotRuns(limit = 20): Promise<SnapshotRun[]> {
  try {
    const blobs: { pathname: string }[] = []; let cursor: string | undefined;
    do { const page = await list({ prefix: `${RUNS_PREFIX}/`, cursor, limit: 1000 }); blobs.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined; } while (cursor);
    const entries = blobs.sort((a, b) => b.pathname.localeCompare(a.pathname)).slice(0, Math.min(100, Math.max(limit, 1)));
    const runs = await Promise.all(entries.map((entry) => readJson<SnapshotRun>(entry.pathname)));
    return runs.filter((run): run is SnapshotRun => Boolean(run)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  } catch {
    return [];
  }
}
