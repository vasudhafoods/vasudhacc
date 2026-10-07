import "server-only";
import { desc, inArray } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { inventorySnapshots } from "@/db/schema";
import { compareInventory } from "@/lib/comparison/inventory";
import type { CurrentInventoryItem, CurrentInventoryResult } from "@/types/shopify";
import type {
  InventoryHistoryResult,
  InventorySnapshotDescriptor,
  InventorySnapshotDocument,
} from "@/types/inventory-snapshot";
import { isPhysicalUnitProduct } from "@/lib/inventory/physical-units";

const KOLKATA_TIME_ZONE = "Asia/Kolkata";
const MAX_HISTORY_SNAPSHOTS = 3;
const SNAPSHOT_PREFIX = "inventory-snapshots";

export function toKolkataDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: KOLKATA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not determine the Asia/Kolkata date.");
  return `${year}-${month}-${day}`;
}

function buildSnapshotPath(snapshotDate: string): string {
  return `${SNAPSHOT_PREFIX}/${snapshotDate}.json`;
}

function physicalUnitItems(inventory: CurrentInventoryResult): CurrentInventoryItem[] {
  return inventory.items.filter((item) => isPhysicalUnitProduct(`${item.productTitle} ${item.variantTitle}`));
}

function buildSnapshotDocument(inventory: CurrentInventoryResult, snapshotDate: string): InventorySnapshotDocument {
  const items = physicalUnitItems(inventory);
  return {
    schemaVersion: 1,
    snapshotDate,
    capturedAt: inventory.capturedAt,
    inventory: {
      ...inventory,
      items,
      summary: {
        ...inventory.summary,
        totalInventory: items.reduce((sum, item) => sum + item.available, 0),
        totalProducts: new Set(items.map((item) => item.productId)).size,
        totalVariants: new Set(items.map((item) => item.variantId)).size,
        totalInventoryItems: new Set(items.map((item) => item.inventoryItemId)).size,
        totalLocations: new Set(items.map((item) => item.locationId)).size,
      },
    },
  };
}

export async function readRecentInventorySnapshots(limit = 30): Promise<InventorySnapshotDocument[]> {
  try {
    const rows = await getDatabase().select({
      snapshotDate: inventorySnapshots.snapshotDate,
      capturedAt: inventorySnapshots.capturedAt,
      inventory: inventorySnapshots.inventory,
    }).from(inventorySnapshots).orderBy(desc(inventorySnapshots.snapshotDate)).limit(Math.min(365, Math.max(1, limit)));
    return rows.reverse().map((row) => ({
      schemaVersion: 1,
      snapshotDate: row.snapshotDate,
      capturedAt: row.capturedAt.toISOString(),
      inventory: row.inventory,
    }));
  } catch {
    return [];
  }
}

export async function readInventorySnapshotsByDate(snapshotDates: string[]): Promise<Map<string, InventorySnapshotDocument>> {
  const requestedDates = [...new Set(snapshotDates)];
  if (requestedDates.length === 0) return new Map();
  try {
    const rows = await getDatabase().select({
      snapshotDate: inventorySnapshots.snapshotDate,
      capturedAt: inventorySnapshots.capturedAt,
      inventory: inventorySnapshots.inventory,
    }).from(inventorySnapshots).where(inArray(inventorySnapshots.snapshotDate, requestedDates));
    return new Map(rows.map((row) => [row.snapshotDate, {
      schemaVersion: 1 as const,
      snapshotDate: row.snapshotDate,
      capturedAt: row.capturedAt.toISOString(),
      inventory: row.inventory,
    }]));
  } catch {
    return new Map();
  }
}

function snapshotLabel(index: number, total: number): string {
  if (total <= 1) return "Today";
  if (total === 2) return index === 0 ? "Yesterday" : "Today";
  return index === 0 ? "Day before" : index === 1 ? "Yesterday" : "Today";
}

function buildComparison(itemsByKey: Map<string, { item: CurrentInventoryItem; values: number[] }>) {
  return [...itemsByKey.values()]
    .map(({ item, values }) =>
      compareInventory({
        ...item,
        dayBeforeYesterday: values[0] ?? 0,
        yesterday: values[1] ?? 0,
        today: values[2] ?? 0,
      }),
    )
    .sort((left, right) => {
      if (left.today !== right.today) return left.today - right.today;
      return left.productTitle.localeCompare(right.productTitle);
    });
}

function alignSnapshotsForComparison(snapshots: InventorySnapshotDocument[]) {
  const valuesByKey = new Map<string, { item: CurrentInventoryItem; values: number[] }>();
  const startIndex = 3 - snapshots.length;

  snapshots.forEach((snapshot, index) => {
    const slotIndex = startIndex + index;
    for (const item of physicalUnitItems(snapshot.inventory)) {
      const key = `${item.inventoryItemId}::${item.locationId}`;
      const existing = valuesByKey.get(key);
      if (existing) {
        existing.item = item;
        existing.values[slotIndex] = item.available;
        continue;
      }
      const values = [0, 0, 0];
      values[slotIndex] = item.available;
      valuesByKey.set(key, { item, values });
    }
  });

  return { valuesByKey };
}

export async function writeCurrentInventorySnapshot(inventory: CurrentInventoryResult): Promise<InventorySnapshotDescriptor> {
  const snapshotDate = toKolkataDateKey(new Date());
  const document = buildSnapshotDocument(inventory, snapshotDate);
  await getDatabase().insert(inventorySnapshots).values({
    snapshotDate,
    capturedAt: new Date(document.capturedAt),
    inventory: document.inventory,
    totalInventory: document.inventory.summary.totalInventory,
    totalProducts: document.inventory.summary.totalProducts,
  }).onConflictDoUpdate({
    target: inventorySnapshots.snapshotDate,
    set: {
      capturedAt: new Date(document.capturedAt),
      inventory: document.inventory,
      totalInventory: document.inventory.summary.totalInventory,
      totalProducts: document.inventory.summary.totalProducts,
      updatedAt: new Date(),
    },
  });

  return {
    pathname: buildSnapshotPath(snapshotDate),
    uploadedAt: document.capturedAt,
    snapshotDate,
  };
}

export async function readLatestInventoryHistory(): Promise<InventoryHistoryResult> {
  const snapshots = await readRecentInventorySnapshots(MAX_HISTORY_SNAPSHOTS);

  if (snapshots.length === 0) {
    return {
      availableSnapshots: 0,
      snapshots: [],
      dailyTotals: [],
      items: [],
    };
  }

  const { valuesByKey } = alignSnapshotsForComparison(snapshots);
  const items = buildComparison(valuesByKey);

  return {
    availableSnapshots: snapshots.length,
    snapshots: snapshots.map((snapshot) => ({
      pathname: buildSnapshotPath(snapshot.snapshotDate),
      uploadedAt: snapshot.capturedAt,
      snapshotDate: snapshot.snapshotDate,
    })),
    dailyTotals: snapshots.map((snapshot, index) => ({
      label: snapshotLabel(index, snapshots.length),
      date: snapshot.snapshotDate,
      inventory: physicalUnitItems(snapshot.inventory).reduce((sum, item) => sum + item.available, 0),
    })),
    items,
  };
}
