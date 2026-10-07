import "server-only";
import { compareInventory } from "@/lib/comparison/inventory";
import { readInventorySnapshotsByDate, readLatestInventoryHistory } from "@/services/inventory-snapshots";
import { fetchCurrentInventory } from "@/services/shopify-inventory";
import type { DailyTotal, InventoryComparison } from "@/types/inventory";
import type { InventorySnapshotDocument } from "@/types/inventory-snapshot";
import type { CurrentInventoryItem, CurrentInventoryResult } from "@/types/shopify";
import { readOperationsSettings } from "@/services/operations-store";
import { isPhysicalUnitProduct } from "@/lib/inventory/physical-units";

export interface InventoryFeed {
  source: "live" | "error";
  mode: "snapshot" | "current" | "error";
  availableSnapshots: number;
  latestSnapshotDate: string | null;
  liveCapturedAt: string | null;
  inventoryDates: {
    dayBeforeYesterday: string;
    yesterday: string;
    today: string;
  };
  snapshotAvailability: {
    dayBeforeYesterday: boolean;
    yesterday: boolean;
  };
  dailyTotals: DailyTotal[];
  items: InventoryComparison[];
  summary: {
    today: number;
    yesterday: number;
    dayBeforeYesterday: number;
    products: number;
    variants: number;
    locations: number;
    lowStock: number;
    outOfStock: number;
  };
  errorMessage: string | null;
}

function buildSummary(items: InventoryComparison[]) {
  const latest = items.reduce(
    (acc, item) => ({
      today: acc.today + item.today,
      yesterday: acc.yesterday + item.yesterday,
      dayBeforeYesterday: acc.dayBeforeYesterday + item.dayBeforeYesterday,
      products: acc.products.add(item.productId),
      variants: acc.variants.add(item.variantId),
      lowStock: acc.lowStock + (item.status === "low-stock" ? 1 : 0),
      outOfStock: acc.outOfStock + (item.status === "out-of-stock" ? 1 : 0),
    }),
    {
      today: 0,
      yesterday: 0,
      dayBeforeYesterday: 0,
      products: new Set<string>(),
      variants: new Set<string>(),
      lowStock: 0,
      outOfStock: 0,
    },
  );

  return {
    today: latest.today,
    yesterday: latest.yesterday,
    dayBeforeYesterday: latest.dayBeforeYesterday,
    products: latest.products.size,
    variants: latest.variants.size,
    locations: new Set(items.map((item) => item.locationId)).size,
    lowStock: latest.lowStock,
    outOfStock: latest.outOfStock,
  };
}

function formatKolkataDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return date.toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
}

function dateKeyDaysBefore(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function itemKey(item: Pick<CurrentInventoryItem, "inventoryItemId" | "locationId">): string {
  return `${item.inventoryItemId}::${item.locationId}`;
}

function physicalUnitItems(items: CurrentInventoryItem[]): CurrentInventoryItem[] {
  return items.filter((item) => isPhysicalUnitProduct(`${item.productTitle} ${item.variantTitle}`));
}

function itemMap(items: CurrentInventoryItem[]): Map<string, CurrentInventoryItem> {
  return new Map(physicalUnitItems(items).map((item) => [itemKey(item), item]));
}

function buildLiveComparison(
  current: CurrentInventoryResult,
  dayBeforeSnapshot: InventorySnapshotDocument | null,
  yesterdaySnapshot: InventorySnapshotDocument | null,
): InventoryComparison[] {
  const currentItems = itemMap(current.items);
  const dayBeforeItems = itemMap(dayBeforeSnapshot?.inventory.items ?? []);
  const yesterdayItems = itemMap(yesterdaySnapshot?.inventory.items ?? []);
  const keys = new Set([...dayBeforeItems.keys(), ...yesterdayItems.keys(), ...currentItems.keys()]);

  return [...keys].map((key) => {
    const currentItem = currentItems.get(key);
    const yesterdayItem = yesterdayItems.get(key);
    const dayBeforeItem = dayBeforeItems.get(key);
    const item = currentItem ?? yesterdayItem ?? dayBeforeItem;
    if (!item) throw new Error("Inventory comparison item metadata is unavailable.");

    const today = currentItem?.available ?? 0;
    const yesterday = yesterdaySnapshot ? (yesterdayItem?.available ?? 0) : today;
    const dayBeforeYesterday = dayBeforeSnapshot
      ? (dayBeforeItem?.available ?? 0)
      : yesterdaySnapshot
        ? yesterday
        : today;

    return compareInventory({
      productId: item.productId,
      variantId: item.variantId,
      inventoryItemId: item.inventoryItemId,
      locationId: item.locationId,
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      sku: item.sku,
      imageUrl: item.imageUrl,
      locationName: item.locationName,
      tracked: item.tracked,
      productStatus: item.productStatus,
      productCreatedAt: item.productCreatedAt,
      productPublishedAt: item.productPublishedAt,
      inventoryItemCreatedAt: item.inventoryItemCreatedAt,
      inventoryItemUpdatedAt: item.inventoryItemUpdatedAt,
      dayBeforeYesterday,
      yesterday,
      today,
    });
  });
}

function buildLiveDailyTotals(
  current: CurrentInventoryResult,
  dayBeforeSnapshot: InventorySnapshotDocument | null,
  yesterdaySnapshot: InventorySnapshotDocument | null,
): DailyTotal[] {
  const totals: DailyTotal[] = [];
  if (dayBeforeSnapshot) totals.push({ label: "Day before", date: dayBeforeSnapshot.snapshotDate, inventory: physicalUnitItems(dayBeforeSnapshot.inventory.items).reduce((sum, item) => sum + item.available, 0) });
  if (yesterdaySnapshot) totals.push({ label: "Yesterday", date: yesterdaySnapshot.snapshotDate, inventory: physicalUnitItems(yesterdaySnapshot.inventory.items).reduce((sum, item) => sum + item.available, 0) });
  totals.push({ label: "Today (live)", date: formatKolkataDateKey(new Date(current.capturedAt)), inventory: physicalUnitItems(current.items).reduce((sum, item) => sum + item.available, 0) });
  return totals;
}

function emptyDates(): InventoryFeed["inventoryDates"] {
  const today = formatKolkataDateKey(new Date());
  return { dayBeforeYesterday: dateKeyDaysBefore(today, 2), yesterday: dateKeyDaysBefore(today, 1), today };
}

function buildErrorFeed(availableSnapshots: number, latestSnapshotDate: string | null, errorMessage: string): InventoryFeed {
  return {
    source: "error",
    mode: "error",
    availableSnapshots,
    latestSnapshotDate,
    liveCapturedAt: null,
    inventoryDates: emptyDates(),
    snapshotAvailability: { dayBeforeYesterday: false, yesterday: false },
    dailyTotals: [],
    items: [],
    summary: {
      today: 0,
      yesterday: 0,
      dayBeforeYesterday: 0,
      products: 0,
      variants: 0,
      locations: 0,
      lowStock: 0,
      outOfStock: 0,
    },
    errorMessage,
  };
}

export async function getInventoryFeed(): Promise<InventoryFeed> {
  const [history, settings] = await Promise.all([readLatestInventoryHistory(), readOperationsSettings()]);

  try {
    const current = await fetchCurrentInventory();
    const today = formatKolkataDateKey(new Date(current.capturedAt));
    const yesterday = dateKeyDaysBefore(today, 1);
    const dayBeforeYesterday = dateKeyDaysBefore(today, 2);
    const snapshots = await readInventorySnapshotsByDate([dayBeforeYesterday, yesterday]);
    const dayBeforeSnapshot = snapshots.get(dayBeforeYesterday) ?? null;
    const yesterdaySnapshot = snapshots.get(yesterday) ?? null;
    const items = buildLiveComparison(current, dayBeforeSnapshot, yesterdaySnapshot).map((item) => compareInventory({ ...item, lowStockThreshold: settings.productThresholds[item.productId] ?? settings.defaultLowStockThreshold }));
    return {
      source: "live",
      mode: "current",
      availableSnapshots: history.availableSnapshots,
      latestSnapshotDate: history.dailyTotals.at(-1)?.date ?? null,
      liveCapturedAt: current.capturedAt,
      inventoryDates: { dayBeforeYesterday, yesterday, today },
      snapshotAvailability: { dayBeforeYesterday: Boolean(dayBeforeSnapshot), yesterday: Boolean(yesterdaySnapshot) },
      dailyTotals: buildLiveDailyTotals(current, dayBeforeSnapshot, yesterdaySnapshot),
      items,
      summary: buildSummary(items),
      errorMessage: null,
    };
  } catch (error) {
    if (history.availableSnapshots > 0) {
      const inventoryDates = emptyDates();
      inventoryDates.today = history.dailyTotals.at(-1)?.date ?? inventoryDates.today;
      inventoryDates.yesterday = history.dailyTotals.at(-2)?.date ?? inventoryDates.yesterday;
      inventoryDates.dayBeforeYesterday = history.dailyTotals.at(-3)?.date ?? inventoryDates.dayBeforeYesterday;
      return {
        source: "live",
        mode: "snapshot",
        availableSnapshots: history.availableSnapshots,
        latestSnapshotDate: history.dailyTotals.at(-1)?.date ?? null,
        liveCapturedAt: null,
        inventoryDates,
        snapshotAvailability: {
          dayBeforeYesterday: history.availableSnapshots >= 3,
          yesterday: history.availableSnapshots >= 2,
        },
        dailyTotals: history.dailyTotals,
        items: history.items.filter((item) => isPhysicalUnitProduct(`${item.productTitle} ${item.variantTitle}`)).map((item) => compareInventory({ ...item, lowStockThreshold: settings.productThresholds[item.productId] ?? settings.defaultLowStockThreshold })),
        summary: buildSummary(history.items.filter((item) => isPhysicalUnitProduct(`${item.productTitle} ${item.variantTitle}`)).map((item) => compareInventory({ ...item, lowStockThreshold: settings.productThresholds[item.productId] ?? settings.defaultLowStockThreshold }))),
        errorMessage: null,
      };
    }

    const errorMessage = error instanceof Error ? error.message : "Shopify inventory could not be loaded.";
    return buildErrorFeed(history.availableSnapshots, history.dailyTotals.at(-1)?.date ?? null, errorMessage);
  }
}
