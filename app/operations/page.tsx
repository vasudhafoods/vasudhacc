import { connection } from "next/server";
import { requireDashboardSession } from "@/lib/auth/authorization";
import { buildInventoryInsights } from "@/services/inventory-insights";
import { fetchCurrentInventory } from "@/services/shopify-inventory";
import type { InventoryInsight } from "@/types/operations";

async function loadInsights(): Promise<{ insights: InventoryInsight[]; error: string | null }> {
  try { return { insights: await buildInventoryInsights(await fetchCurrentInventory()), error: null }; }
  catch (error) { return { insights: [], error: error instanceof Error ? error.message : "Shopify inventory could not be loaded." }; }
}

export default async function OperationsPage() {
  await requireDashboardSession(); await connection();
  const result = await loadInsights();
  if (result.error) return <div className="rounded-xl border border-rose-200 bg-rose-50 p-6"><h1 className="text-xl font-semibold">Stock planning unavailable</h1><p className="mt-2 text-sm">{result.error}</p></div>;
  const insights = result.insights;
  return <div className="space-y-6">
    <div><p className="text-xs font-medium text-emerald-700">Operational intelligence</p><h1 className="mt-1 text-2xl font-semibold text-slate-900">Stock planning</h1><p className="mt-1 text-sm text-slate-500">Depletion-based estimates from saved snapshots. Projections improve as daily history accumulates.</p></div>
    <section className="grid gap-4 sm:grid-cols-3"><Metric label="Reorder recommendations" value={insights.filter((item) => item.reorderQuantity > 0).length}/><Metric label="Dead-stock rows" value={insights.filter((item) => item.deadStock).length}/><Metric label="History available" value={`${Math.max(0, ...insights.map((item) => item.historyDays))} days`}/></section>
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full min-w-[1180px] text-left text-xs"><thead className="bg-slate-50 text-slate-400"><tr><th className="px-5 py-3">Product</th><th>Variant / SKU</th><th>Location</th><th className="text-right">Stock</th><th className="text-right">Avg depletion/day</th><th className="text-right">Days to stockout</th><th className="text-right">Recommended reorder</th><th className="text-right">Inventory age</th><th className="text-right">No movement</th><th>Flag</th></tr></thead><tbody>{insights.map((item) => <InsightRow key={`${item.inventoryItemId}-${item.locationId}`} item={item}/>)}</tbody></table></div>
  </div>;
}

function InsightRow({ item }: { item: InventoryInsight }) { return <tr className="border-t border-slate-100"><td className="px-5 py-3 font-semibold text-slate-800">{item.productTitle}</td><td>{item.variantTitle}<span className="block text-slate-400">{item.sku ?? "No SKU"}</span></td><td>{item.locationName}</td><td className="text-right">{item.currentStock}</td><td className="text-right">{item.averageDailySales}</td><td className="text-right">{item.daysUntilStockout ?? "—"}</td><td className="text-right font-semibold text-emerald-700">{item.reorderQuantity || "—"}</td><td className="text-right">{item.inventoryAgeDays === null ? "—" : `${item.inventoryAgeDays} days`}</td><td className="text-right">{item.daysWithoutMovement} days</td><td>{item.deadStock ? <span className="text-amber-700">Dead stock</span> : item.historyDays < 7 ? <span className="text-slate-400">Warming up</span> : "—"}</td></tr>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p></div>; }
