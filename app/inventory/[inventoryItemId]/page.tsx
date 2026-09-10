import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { StatusBadge } from "@/components/inventory/status-badge";
import { requireDashboardSession } from "@/lib/auth/authorization";
import { getInventoryFeed } from "@/lib/inventory/live-data";
import { getProductPhysicalStock } from "@/services/product-physical-stock";
import type { InventoryComparison, InventoryStatus } from "@/types/inventory";

export const dynamic = "force-dynamic";

const statusRank: Record<InventoryStatus, number> = { "out-of-stock": 0, "low-stock": 1, "stock-reduced": 2, "stock-increased": 3, "in-stock": 4 };

function packNumber(item: InventoryComparison): number {
  const match = `${item.variantTitle} ${item.productTitle}`.match(/\bpack\s+of\s+(\d+)\b/i);
  return match ? Number(match[1]) : 1;
}

function packLabel(item: InventoryComparison): string {
  const size = packNumber(item);
  if (item.variantTitle === "Default Title") return `Pack of ${size}`;
  return item.variantTitle;
}

function productStatus(items: InventoryComparison[]): InventoryStatus {
  return [...items].sort((left, right) => statusRank[left.status] - statusRank[right.status])[0]?.status ?? "in-stock";
}

export default async function InventoryDetail({ params }: { params: Promise<{ inventoryItemId: string }> }) {
  await requireDashboardSession();
  await connection();
  const { inventoryItemId } = await params;
  const [feed, physicalStock] = await Promise.all([getInventoryFeed(), getProductPhysicalStock()]);
  const selected = feed.items.find((item) => item.productId === inventoryItemId || item.inventoryItemId === inventoryItemId);
  if (!selected) notFound();
  const variants = feed.items
    .filter((item) => item.productId === selected.productId)
    .sort((left, right) => packNumber(left) - packNumber(right) || left.variantTitle.localeCompare(right.variantTitle) || left.locationName.localeCompare(right.locationName));
  const physical = physicalStock[selected.productId] ?? null;

  return <div className="space-y-6">
    <Link href="/inventory" className="text-xs font-semibold text-[#246552]">← Back to product inventory</Link>
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <div className="flex items-center gap-4">{selected.imageUrl ? <Image src={selected.imageUrl} alt="" width={64} height={64} className="size-16 rounded-xl object-cover"/> : <div className="grid size-16 place-items-center rounded-xl bg-[#f2eee3] text-xl font-semibold text-[#8f7c45]">{selected.productTitle[0]}</div>}<div><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Product stock details</p><h1 className="mt-1 text-2xl font-semibold text-slate-900">{selected.productTitle}</h1><p className="mt-1 text-sm capitalize text-slate-500">{(selected.productStatus ?? "unknown").toLowerCase()} · {new Set(variants.map((variant) => variant.variantId)).size} pack options</p></div></div>
      <StatusBadge status={productStatus(variants)}/>
    </div>

    <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-emerald-700">Actual physical stock</p><p className="mt-1 text-sm text-emerald-950">Individual packets recorded in the warehouse ledger. Damaged packets are excluded from the actual total.</p></div>{!physical?.recorded ? <span className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-bold text-amber-800">Opening stock not recorded</span> : null}</div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6"><PhysicalMetric label="Actual packets" value={physical?.recorded ? physical.actual : null} strong/><PhysicalMetric label="Online" value={physical?.recorded ? physical.online : null}/><PhysicalMetric label="Retail" value={physical?.recorded ? physical.retail : null}/><PhysicalMetric label="Buffer" value={physical?.recorded ? physical.buffer : null}/><PhysicalMetric label="QC" value={physical?.recorded ? physical.qc : null}/><PhysicalMetric label="Damaged" value={physical?.recorded ? physical.damaged : null}/></div>
    </section>

    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 p-5"><h2 className="text-base font-bold text-slate-900">Shopify pack-option stock</h2><p className="mt-1 text-xs leading-5 text-slate-500">Each row is a separate Shopify variant and location. These sellable pack counts are shown separately and are not added together to calculate physical stock.</p></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">Pack option</th><th className="px-3 py-3">SKU</th><th className="px-3 py-3">Shopify location</th><th className="px-3 py-3 text-right">Day before</th><th className="px-3 py-3 text-right">Yesterday</th><th className="px-3 py-3 text-right">Today · available</th><th className="px-3 py-3 text-right">Today change</th><th className="px-3 py-3">Tracking</th><th className="px-5 py-3">Status</th></tr></thead><tbody>{variants.map((variant) => <tr key={`${variant.inventoryItemId}-${variant.locationId}`} className="border-t border-slate-100 text-slate-600"><td className="px-5 py-3.5"><p className="font-bold text-slate-900">{packLabel(variant)}</p><p className="mt-1 text-[10px] text-slate-400">{packNumber(variant)} individual packet{packNumber(variant) === 1 ? "" : "s"} per sale</p></td><td className="px-3 py-3.5 font-medium">{variant.sku ?? "No SKU"}</td><td className="px-3 py-3.5">{variant.locationName}</td><td className="px-3 py-3.5 text-right tabular-nums">{feed.snapshotAvailability.dayBeforeYesterday ? variant.dayBeforeYesterday : <span className="text-slate-300">—</span>}</td><td className="px-3 py-3.5 text-right tabular-nums">{feed.snapshotAvailability.yesterday ? variant.yesterday : <span className="text-slate-300">—</span>}</td><td className="px-3 py-3.5 text-right text-lg font-bold tabular-nums text-slate-950">{variant.today}</td><td className={`px-3 py-3.5 text-right font-bold tabular-nums ${variant.todayChange > 0 ? "text-emerald-700" : variant.todayChange < 0 ? "text-red-600" : "text-slate-400"}`}>{feed.snapshotAvailability.yesterday ? `${variant.todayChange > 0 ? "+" : ""}${variant.todayChange}` : "—"}</td><td className="px-3 py-3.5">{variant.tracked === false ? "Untracked" : "Tracked"}</td><td className="px-5 py-3.5"><StatusBadge status={variant.status}/></td></tr>)}</tbody></table></div>
    </section>

    <details className="rounded-xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer text-sm font-bold text-slate-800">Shopify product identifiers</summary><dl className="mt-4 grid gap-4 sm:grid-cols-2"><Detail label="Shopify product ID" value={selected.productId}/>{variants.map((variant) => <Detail key={`${variant.inventoryItemId}-${variant.locationId}`} label={`${packLabel(variant)} · ${variant.locationName}`} value={variant.inventoryItemId}/>)}</dl></details>
  </div>;
}

function PhysicalMetric({ label, value, strong = false }: { label: string; value: number | null; strong?: boolean }) {
  return <div className={`rounded-xl border p-3 ${strong ? "border-emerald-300 bg-white" : "border-emerald-100 bg-white/70"}`}><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className={`mt-1 font-bold text-slate-900 ${strong ? "text-2xl" : "text-xl"}`}>{value ?? "—"}</p></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt><dd className="mt-1 break-all text-xs text-slate-700">{value}</dd></div>;
}
