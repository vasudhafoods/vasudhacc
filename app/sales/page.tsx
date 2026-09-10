import { connection } from "next/server";
import { OfflineSalesWorkspace } from "@/components/sales/offline-sales-workspace";
import { requireSalesSession } from "@/lib/auth/authorization";
import { getInventoryFeed } from "@/lib/inventory/live-data";
import { resolveSalesDateRange } from "@/lib/sales/date-range";
import { getOfflineSalesOverview } from "@/services/offline-sales";
import { fetchSalesReport } from "@/services/shopify-sales";
import type { OfflineSalesOverview } from "@/types/offline-sales";
import type { SalesReport } from "@/types/sales";

type SearchParams = Record<string, string | string[] | undefined>;

const money = (value: number, currency: string) => new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
const paisa = (value: number) => money(value / 100, "INR");

type MaybeReport = { report: SalesReport | null; error: string | null };
type MaybeOffline = { data: OfflineSalesOverview | null; error: string | null };

async function readShopifySales(range: { from: string; to: string }): Promise<MaybeReport> {
  try { return { report: await fetchSalesReport(range), error: null }; }
  catch (error) { return { report: null, error: error instanceof Error ? error.message : "Shopify orders could not be loaded." }; }
}

async function readOfflineSales(range: { from: string; to: string }): Promise<MaybeOffline> {
  try { return { data: await getOfflineSalesOverview(range), error: null }; }
  catch (error) { return { data: null, error: error instanceof Error ? error.message : "Offline sales could not be loaded." }; }
}

async function loadSales(current: { from: string; to: string }, previous: { from: string; to: string }) {
  const [report, prior, inventory, offline, previousOffline] = await Promise.all([
    readShopifySales(current),
    readShopifySales(previous),
    getInventoryFeed().then((value) => ({ value, error: null as string | null })).catch((error: unknown) => ({ value: null, error: error instanceof Error ? error.message : "Inventory could not be loaded." })),
    readOfflineSales(current),
    readOfflineSales(previous),
  ]);
  return { report, prior, inventory, offline, previousOffline };
}

function totalUnits(report: SalesReport): number {
  return report.daily.reduce((sum, day) => sum + day.units, 0);
}

function change(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Number(((current - previous) / previous * 100).toFixed(1));
}

export default async function SalesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSalesSession();
  await connection();
  const range = resolveSalesDateRange(await searchParams);
  const result = await loadSales(range.current, range.previous);
  const report = result.report.report;
  const previous = result.prior.report;
  const offline = result.offline.data;
  const previousOffline = result.previousOffline.data;
  const onlineRevenue = report?.netRevenue ?? 0;
  const previousOnlineRevenue = previous?.netRevenue ?? 0;
  const offlineRevenue = offline?.salesAmountPaisa ?? 0;
  const previousOfflineRevenue = previousOffline?.salesAmountPaisa ?? 0;
  const combinedRevenue = onlineRevenue + offlineRevenue / 100;
  const previousCombinedRevenue = previousOnlineRevenue + previousOfflineRevenue / 100;

  const stockByProduct = new Map<string, number>();
  if (result.inventory.value) for (const item of result.inventory.value.items) stockByProduct.set(item.productId, (stockByProduct.get(item.productId) ?? 0) + item.today);
  const previousProducts = new Map((previous?.products ?? []).map((product) => [product.productId ?? product.title, product]));
  const currentUnits = report ? totalUnits(report) : 0;
  const previousUnits = previous ? totalUnits(previous) : 0;
  const cancellationRate = report?.orders ? report.cancelledOrders / report.orders * 100 : 0;
  const previousCancellationRate = previous?.orders ? previous.cancelledOrders / previous.orders * 100 : 0;

  return <div className="space-y-6">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><p className="text-xs font-medium text-[#2d725f]">Commerce intelligence</p><h1 className="mt-1 text-2xl font-semibold text-slate-900">Sales analytics</h1><p className="mt-1 text-sm text-slate-500">Online Shopify and offline retail sales for {range.label}, compared with {range.previousLabel}.</p></div><DateFilter range={range}/></div>

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <Metric label="Online sales" value={report ? money(onlineRevenue, report.currency) : "Unavailable"} previous={previous ? money(previousOnlineRevenue, previous.currency) : "—"} change={report && previous ? change(onlineRevenue, previousOnlineRevenue) : null}/>
      <Metric label="Offline invoiced sales" value={offline ? paisa(offlineRevenue) : "Unavailable"} previous={previousOffline ? paisa(previousOfflineRevenue) : "—"} change={offline && previousOffline ? change(offlineRevenue, previousOfflineRevenue) : null}/>
      <Metric label="Combined sales" value={money(combinedRevenue, report?.currency ?? "INR")} previous={money(previousCombinedRevenue, previous?.currency ?? "INR")} change={report && previous && offline && previousOffline ? change(combinedRevenue, previousCombinedRevenue) : null}/>
      <Metric label="Offline collections" value={offline ? paisa(offline.collectedAmountPaisa) : "Unavailable"} previous={previousOffline ? paisa(previousOffline.collectedAmountPaisa) : "—"} change={offline && previousOffline ? change(offline.collectedAmountPaisa, previousOffline.collectedAmountPaisa) : null}/>
      <Metric label="Open offline receivables" value={offline ? paisa(offline.openReceivablesPaisa) : "Unavailable"} previous="All unpaid invoices" change={null} inverse/>
      <Metric label="New B2B customers" value={offline?.newB2bCustomers ?? "—"} previous={previousOffline?.newB2bCustomers ?? "—"} change={offline && previousOffline ? change(offline.newB2bCustomers, previousOffline.newB2bCustomers) : null}/>
    </section>

    {offline ? <OfflineSalesWorkspace overview={offline} role={session.role}/> : <div className="rounded-xl border border-amber-200 bg-amber-50 p-5"><p className="font-semibold text-amber-950">Offline sales is not ready yet</p><p className="mt-1 text-sm text-amber-900">{result.offline.error ?? "Run the database migration to create the offline sales ledger."}</p></div>}

    {report && previous ? <>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><Metric label="Shopify orders" value={report.orders} previous={previous.orders} change={change(report.orders, previous.orders)}/><Metric label="Shopify items sold" value={currentUnits} previous={previousUnits} change={change(currentUnits, previousUnits)}/><Metric label="Average online order value" value={money(report.averageOrderValue, report.currency)} previous={money(previous.averageOrderValue, previous.currency)} change={change(report.averageOrderValue, previous.averageOrderValue)}/><Metric label="Shopify refunds" value={money(report.refunds, report.currency)} previous={money(previous.refunds, previous.currency)} change={change(report.refunds, previous.refunds)} inverse/><Metric label="Cancellation rate" value={`${cancellationRate.toFixed(1)}%`} previous={`${previousCancellationRate.toFixed(1)}%`} change={change(cancellationRate, previousCancellationRate)} inverse/></section>
      <section className="grid gap-5 xl:grid-cols-2"><ProductTable title="Best-selling online products" products={report.products.slice(0, 10)} stock={stockByProduct} previousProducts={previousProducts} currency={report.currency}/><ProductTable title="Slow-moving online products" products={[...report.products].sort((left, right) => left.units - right.units).slice(0, 10)} stock={stockByProduct} previousProducts={previousProducts} currency={report.currency}/></section>
      <DailyTable report={report} previous={previous}/>
    </> : <div className="rounded-xl border border-amber-200 bg-amber-50 p-5"><p className="font-semibold text-amber-950">Shopify online sales are unavailable</p><p className="mt-1 text-sm text-amber-900">{result.report.error ?? "Release a Shopify app version with read_orders, then approve the updated access."} Offline sales and collections remain available above.</p></div>}
  </div>;
}

function DateFilter({ range }: { range: ReturnType<typeof resolveSalesDateRange> }) {
  return <form className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-[minmax(154px,1fr)_140px_140px_auto]" method="get"><label className="sr-only" htmlFor="sales-range">Reporting range</label><select id="sales-range" name="range" defaultValue={range.preset} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"><option value="last_7_days">Last 7 days</option><option value="last_30_days">Last 30 days</option><option value="this_month">This month</option><option value="last_month">Last month</option><option value="custom">Custom range</option></select><label className="sr-only" htmlFor="sales-from">From date</label><input id="sales-from" name="from" type="date" defaultValue={range.current.from} className="h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700"/><label className="sr-only" htmlFor="sales-to">To date</label><input id="sales-to" name="to" type="date" defaultValue={range.current.to} className="h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700"/><button type="submit" className="h-10 rounded-lg bg-[#174f40] px-4 text-sm font-semibold text-white">Apply</button><p className="sm:col-span-4 text-[11px] text-slate-500">Choose Custom range to apply selected dates. Maximum range: 60 days.</p></form>;
}

function Metric({ label, value, previous, change: delta, inverse = false }: { label: string; value: string | number; previous: string | number; change: number | null; inverse?: boolean }) {
  const positive = inverse ? (delta ?? 0) < 0 : (delta ?? 0) > 0;
  const negative = inverse ? (delta ?? 0) > 0 : (delta ?? 0) < 0;
  return <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-xl font-semibold text-slate-900">{value}</p><div className="mt-3 flex items-center justify-between gap-3 text-xs"><span className="text-slate-400">Previous {previous}</span><span className={positive ? "font-semibold text-emerald-700" : negative ? "font-semibold text-red-600" : "font-semibold text-slate-400"}>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}%`}</span></div></div>;
}

function ProductTable({ title, products, stock, previousProducts, currency }: { title: string; products: SalesReport["products"]; stock: Map<string, number>; previousProducts: Map<string, SalesReport["products"][number]>; currency: string }) {
  return <div className="overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="border-b border-slate-100 p-5"><h2 className="text-sm font-semibold text-slate-900">{title}</h2><p className="mt-1 text-xs text-slate-500">Current period performance against the preceding period.</p></div><div className="divide-y divide-slate-100">{products.map((product) => { const prior = previousProducts.get(product.productId ?? product.title); const delta = change(product.revenue, prior?.revenue ?? 0); return <div key={product.productId ?? product.title} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-5 py-3 text-xs"><span className="min-w-0"><span className="block truncate font-semibold text-slate-700">{product.title}</span><span className="mt-1 block text-slate-400">{product.units} sold · {product.productId ? stock.get(product.productId) ?? 0 : "-"} stock</span></span><span className="text-right font-semibold text-slate-700">{money(product.revenue, currency)}</span><span className={`w-14 text-right font-semibold ${delta === null || delta === 0 ? "text-slate-400" : delta > 0 ? "text-emerald-700" : "text-red-600"}`}>{delta === null ? "New" : `${delta > 0 ? "+" : ""}${delta}%`}</span></div>; })}</div></div>;
}

function DailyTable({ report, previous }: { report: SalesReport; previous: SalesReport }) {
  return <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><div className="border-b border-slate-100 p-5"><h2 className="text-sm font-semibold text-slate-900">Daily online sales comparison</h2><p className="mt-1 text-xs text-slate-500">Each day is matched with the equivalent day in the preceding period.</p></div><table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-slate-50 text-slate-400"><tr><th className="px-5 py-3">Date</th><th className="text-right">Orders</th><th className="text-right">Net sales</th><th className="text-right">Previous sales</th><th className="text-right">Change</th><th className="px-5 text-right">Refunds</th></tr></thead><tbody>{report.daily.map((day, index) => { const prior = previous.daily[index]; const net = day.revenue - day.refunds; const previousNet = prior ? prior.revenue - prior.refunds : 0; const delta = change(net, previousNet); return <tr key={day.date} className="border-t border-slate-100"><td className="px-5 py-2.5 font-medium text-slate-700">{day.date}</td><td className="text-right">{day.orders}</td><td className="text-right font-semibold text-slate-800">{money(net, report.currency)}</td><td className="text-right text-slate-500">{prior ? money(previousNet, previous.currency) : "-"}</td><td className={`text-right font-semibold ${delta === null || delta === 0 ? "text-slate-400" : delta > 0 ? "text-emerald-700" : "text-red-600"}`}>{delta === null ? "New" : `${delta > 0 ? "+" : ""}${delta}%`}</td><td className="px-5 text-right text-red-600">{money(day.refunds, report.currency)}</td></tr>; })}</tbody></table></div>;
}
