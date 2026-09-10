import { getInventoryFeed } from "@/lib/inventory/live-data";
import { InventoryTable } from "@/components/inventory/inventory-table";
import { SnapshotStatusStrip } from "@/components/inventory/snapshot-status-strip";
import { connection } from "next/server";
import { requireDashboardSession } from "@/lib/auth/authorization";
import { SnapshotControls } from "@/components/inventory/snapshot-controls";
import { readSnapshotRuns, readOperationsSettings } from "@/services/operations-store";
import { getProductPhysicalStock } from "@/services/product-physical-stock";
export default async function InventoryPage() {
  await requireDashboardSession();
  await connection();
  const [feed, runs, settings, physicalStock] = await Promise.all([getInventoryFeed(), readSnapshotRuns(10), readOperationsSettings(), getProductPhysicalStock()]);
  return <div className="space-y-6"><div><p className="text-xs font-medium text-[#2d725f]">Inventory</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{feed.mode === "snapshot" ? "Inventory snapshot fallback" : feed.mode === "current" ? "Live product inventory" : "Inventory unavailable"}</h1><p className="mt-1 text-sm text-slate-500">The main list shows actual individual packets from the warehouse ledger. Open a product to see Pack of 1, Pack of 3, Pack of 5, and other Shopify variant quantities.</p></div><SnapshotStatusStrip feed={feed}/><SnapshotControls today={feed.inventoryDates.today} latestSnapshotDate={feed.latestSnapshotDate} runs={runs}/><InventoryTable items={feed.items} feed={feed} physicalStock={physicalStock} hideUntrackedByDefault={settings.hideUntrackedByDefault}/></div>;
}
