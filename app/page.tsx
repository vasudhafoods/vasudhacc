import Link from "next/link";
import { connection } from "next/server";
import { requireDashboardSession } from "@/lib/auth/authorization";
import { getExecutiveDashboard } from "@/services/executive-dashboard";
import type { CommandCenterDecision, CommandCenterHealth } from "@/types/command-center";
import type { ExecutiveRecommendation, ExecutiveRecommendationPriority } from "@/types/executive";

const integer = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

function money(value: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

function signedPercent(value: number | null): string {
  if (value === null) return "Warming up";
  return `${value > 0 ? "+" : ""}${value}%`;
}

export default async function Home() {
  await requireDashboardSession();
  await connection();
  const data = await getExecutiveDashboard();
  const { view, warehouse, sales, trend } = data;
  const currency = sales?.currency ?? "INR";
  const urgentActions = data.recommendations.filter((item) => item.priority === "urgent" || item.priority === "important").length;
  const topProducts = data.products.filter((product) => product.units > 0).slice(0, 6);

  return <div className="space-y-7">
    <header className="rounded-2xl bg-[#143f34] px-5 py-6 text-white shadow-sm sm:px-7">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-200">CEO command summary · Last 30 days</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Sales, marketing and inventory—in one view</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-50">A live executive brief from Shopify and the warehouse ledger, with exceptions and next actions presented first.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold ${urgentActions ? "bg-amber-100 text-amber-950" : "bg-emerald-100 text-emerald-950"}`}><span className={`size-2 rounded-full ${urgentActions ? "bg-amber-500" : "bg-emerald-500"}`}/>{urgentActions ? `${urgentActions} priority actions` : "No urgent exception"}</span>
          <a href="/api/executive/export" className="inline-flex items-center rounded-xl border border-white/30 bg-white px-4 py-2 text-xs font-bold text-[#143f34]">Download CEO Excel</a>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t border-white/15 pt-4 text-[11px] text-emerald-100"><span>Shopify: {view.mode === "live" ? "Live" : view.mode === "snapshot" ? "Snapshot fallback" : "Unavailable"}</span><span>Warehouse: {warehouse.initialized ? "Connected" : "Not ready"}</span><span>Generated: {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(data.generatedAt))}</span></div>
    </header>

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Net Shopify sales" value={sales ? money(sales.netRevenue, currency) : "Unavailable"} helper={sales ? `${sales.from} to ${sales.to}` : data.salesError ?? "Order access required"} tone="green"/>
      <Metric label="Orders" value={sales ? integer.format(sales.orders) : "—"} helper={trend ? `${integer.format(trend.units)} product units sold` : "Shopify sales unavailable"}/>
      <Metric label="Total physical stock" value={warehouse.initialized ? integer.format(warehouse.physicalStock) : "Unavailable"} helper="Online + Retail + Buffer + QC base packets"/>
      <Metric label="Stock requiring action" value={integer.format(view.outOfStockSkus + view.lowStockSkus)} helper={`${view.outOfStockSkus} out of stock · ${view.lowStockSkus} low`} tone={view.outOfStockSkus + view.lowStockSkus ? "amber" : "green"}/>
      <Metric label="Average order value" value={sales ? money(sales.averageOrderValue, currency) : "—"} helper="Net revenue per Shopify order"/>
      <Metric label="7-day sales movement" value={signedPercent(trend?.revenueChangePercent ?? null)} helper="Completed days vs prior 7 completed days" tone={(trend?.revenueChangePercent ?? 0) < 0 ? "amber" : "green"}/>
      <Metric label="Refund rate" value={trend ? `${trend.refundRatePercent}%` : "—"} helper={sales ? `${money(sales.refunds, currency)} refunded` : "Sales unavailable"} tone={(trend?.refundRatePercent ?? 0) >= 5 ? "amber" : "slate"}/>
      <Metric label="Marketing attribution" value={sales ? `${sales.marketing.attributionCoveragePercent}%` : "—"} helper={sales ? `${sales.marketing.attributedOrders} of ${sales.marketing.eligibleOrders} eligible orders identified` : "Shopify journey unavailable"} tone={(sales?.marketing.attributionCoveragePercent ?? 0) >= 70 ? "green" : "amber"}/>
    </section>

    <section className="grid gap-5 xl:grid-cols-[1.25fr_.75fr]">
      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex flex-col justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-start">
          <div><p className="text-xs font-semibold uppercase tracking-[.14em] text-[#2d725f]">Decision intelligence</p><h2 className="mt-1 text-lg font-bold text-slate-950">What needs the CEO’s attention</h2><p className="mt-1 text-xs leading-5 text-slate-500">Explainable, data-based suggestions with no added AI API cost. Each action cites the condition that triggered it.</p></div>
          <Link href="/attention" className="shrink-0 text-xs font-bold text-emerald-700">All stock alerts →</Link>
        </div>
        <div className="divide-y divide-slate-100">{data.recommendations.slice(0, 6).map((recommendation) => <Recommendation key={recommendation.id} item={recommendation}/>)}</div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-violet-700">Marketing analytics</p><h2 className="mt-1 text-lg font-bold text-slate-950">Revenue by acquisition source</h2></div><span className="rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-bold text-violet-700">Shopify attribution</span></div>
        {sales ? <>
          <div className="mt-5 grid grid-cols-2 gap-3"><MiniMetric label="New-customer orders" value={sales.marketing.newCustomerOrders}/><MiniMetric label="Returning orders" value={sales.marketing.returningCustomerOrders}/><MiniMetric label="Attributed orders" value={sales.marketing.attributedOrders}/><MiniMetric label="Avg. conversion time" value={sales.marketing.averageDaysToConversion === null ? "—" : `${sales.marketing.averageDaysToConversion} days`}/></div>
          <div className="mt-5"><div className="mb-2 flex justify-between text-[11px] font-semibold text-slate-500"><span>Attribution coverage</span><span>{sales.marketing.attributionCoveragePercent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.min(100, sales.marketing.attributionCoveragePercent)}%` }}/></div></div>
          <div className="mt-5 divide-y divide-slate-100">{sales.marketing.sources.slice(0, 5).map((source) => <div key={source.label} className="flex items-center gap-3 py-3 text-xs"><div className="min-w-0 flex-1"><p className="truncate font-bold text-slate-800">{source.label}</p><p className="mt-0.5 text-slate-400">{source.orders} orders · {source.units} units</p></div><p className="font-bold text-slate-900">{money(source.revenue, currency)}</p></div>)}{!sales.marketing.sources.length ? <p className="py-6 text-center text-xs text-slate-500">No attributed sources yet. Add UTM tags to marketing links.</p> : null}</div>
        </> : <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Marketing attribution needs working Shopify order access.</p>}
        <div className="mt-5 rounded-xl border border-dashed border-violet-200 bg-violet-50/60 p-4 text-xs leading-5 text-violet-950"><strong>Next connection:</strong> GA4 for sessions and conversion funnel; Meta/Instagram for spend, reach and ROAS; Search Console for organic search queries and CTR.</div>
      </div>
    </section>

    <section className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-blue-700">Sales × stock</p><h2 className="mt-1 text-lg font-bold text-slate-950">Winning products and stock cover</h2><p className="mt-1 text-xs text-slate-500">Stock uses {data.productStockSource === "warehouse-ledger" ? "Online base packets from the warehouse ledger" : "current Shopify listing units"}.</p></div><Link href="/sales" className="shrink-0 text-xs font-bold text-emerald-700">Full sales →</Link></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs"><thead className="bg-slate-50 text-slate-400"><tr><th className="px-5 py-3">Product</th><th className="text-right">Units sold</th><th className="text-right">Revenue</th><th className="px-5 text-right">Online stock</th></tr></thead><tbody>{topProducts.map((product) => <tr key={product.productId ?? product.title} className="border-t border-slate-100"><td className="max-w-xs px-5 py-3 font-bold text-slate-800">{product.title}</td><td className="text-right">{product.units}</td><td className="text-right">{money(product.revenue, currency)}</td><td className={`px-5 text-right font-bold ${(product.onlineStock ?? 0) <= 0 ? "text-red-600" : "text-slate-800"}`}>{product.onlineStock ?? "—"}</td></tr>)}{!topProducts.length ? <tr><td colSpan={4} className="px-5 py-10 text-center text-slate-500">Sales product data is unavailable.</td></tr> : null}</tbody></table></div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Inventory position</p><h2 className="mt-1 text-lg font-bold text-slate-950">Channel stock and control health</h2></div><Link href="/inventory" className="text-xs font-bold text-emerald-700">Inventory →</Link></div>
        <div className="mt-5 grid grid-cols-2 gap-3"><MiniMetric label="Online packets" value={warehouse.initialized ? warehouse.onlineAllocation : view.onlineStock}/><MiniMetric label="Retail packets" value={warehouse.initialized ? warehouse.retailStock : "—"}/><MiniMetric label="Buffer packets" value={warehouse.initialized ? warehouse.bufferStock : "—"}/><MiniMetric label="No recent sales" value={data.stockedProductsWithoutSales}/></div>
        <div className="mt-5 space-y-2 text-xs"><HealthLine label="Shopify webhook failures" value={warehouse.failedShopifyWebhooks} good={warehouse.failedShopifyWebhooks === 0}/><HealthLine label="Pending Shopify writes" value={warehouse.pendingShopifyUpdates} good={warehouse.pendingShopifyUpdates === 0}/><HealthLine label="Missing SKU rows" value={view.missingSkus} good={view.missingSkus === 0}/><HealthLine label="Warehouse ledger transactions" value={warehouse.transactions} good={warehouse.initialized}/></div>
      </div>
    </section>

    <section className="grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
      <div className="rounded-2xl border border-slate-200 bg-white"><div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4"><div><h2 className="text-sm font-bold text-slate-900">Products needing stock decisions</h2><p className="mt-1 text-xs text-slate-500">Demand, remaining Online stock, and estimated cover.</p></div><Link href="/operations" className="shrink-0 text-xs font-bold text-emerald-700">Stock planning →</Link></div><div className="divide-y divide-slate-100">{view.decisions.slice(0, 5).map((decision) => <Decision key={decision.id} decision={decision}/>)}{!view.decisions.length ? <div className="p-8 text-center"><p className="text-sm font-bold text-slate-700">No demand-based stock decision is urgent</p><p className="mt-1 text-xs text-slate-500">The queue populates when stock cover falls below 10 days.</p></div> : null}</div></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs font-semibold uppercase tracking-[.14em] text-amber-700">What is still lacking</p><h2 className="mt-1 text-lg font-bold text-slate-950">Data required for deeper decisions</h2><div className="mt-4 space-y-3">{data.dataGaps.map((gap, index) => <div key={gap} className="flex gap-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-950"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-200 font-bold">{index + 1}</span><p>{gap}</p></div>)}</div></div>
    </section>
  </div>;
}

function Metric({ label, value, helper, tone = "slate" }: { label: string; value: string; helper: string; tone?: "slate" | "green" | "amber" }) {
  const color = tone === "green" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : "text-slate-900";
  return <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs font-medium text-slate-500">{label}</p><p className={`mt-2 text-2xl font-bold ${color}`}>{value}</p><p className="mt-1 text-[11px] leading-5 text-slate-400">{helper}</p></div>;
}

function MiniMetric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-xl font-bold text-slate-800">{value}</p></div>;
}

const priorityStyle: Record<ExecutiveRecommendationPriority, string> = {
  urgent: "bg-red-100 text-red-800",
  important: "bg-amber-100 text-amber-800",
  opportunity: "bg-blue-100 text-blue-800",
  monitor: "bg-slate-100 text-slate-700",
};

function Recommendation({ item }: { item: ExecutiveRecommendation }) {
  return <article className="px-5 py-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start"><div className="flex shrink-0 gap-2"><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${priorityStyle[item.priority]}`}>{item.priority}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600">{item.area}</span></div><div><h3 className="text-sm font-bold text-slate-900">{item.title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{item.evidence}</p><p className="mt-2 text-xs leading-5 text-slate-800"><strong>Action:</strong> {item.action}</p></div></div></article>;
}

function HealthLine({ label, value, good }: { label: string; value: number; good: boolean }) {
  return <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5"><span className="text-slate-600">{label}</span><span className={`font-bold ${good ? "text-emerald-700" : "text-amber-700"}`}>{value}</span></div>;
}

function Decision({ decision }: { decision: CommandCenterDecision }) {
  return <article className="p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><HealthBadge health={decision.health}/><span className="text-[11px] text-slate-400">{decision.sku ?? "Missing SKU"}</span></div><h3 className="mt-2 text-sm font-bold text-slate-900">{decision.productTitle}</h3><p className="mt-1 text-xs leading-5 text-slate-600">{decision.reason}</p></div><div className="grid shrink-0 grid-cols-3 gap-2 text-center"><DecisionNumber label="Online" value={decision.onlineStock}/><DecisionNumber label="Avg/day" value={decision.averageDailyUnits}/><DecisionNumber label="Cover" value={decision.daysCover === null ? "—" : `${decision.daysCover}d`}/></div></div></article>;
}

function DecisionNumber({ label, value }: { label: string; value: string | number }) {
  return <div className="min-w-16 rounded-lg bg-slate-50 px-2 py-2"><p className="text-[9px] uppercase text-slate-400">{label}</p><p className="mt-1 text-xs font-bold text-slate-800">{value}</p></div>;
}

const healthStyles: Record<CommandCenterHealth, string> = { healthy: "bg-emerald-50 text-emerald-700", monitor: "bg-blue-50 text-blue-700", low: "bg-amber-50 text-amber-700", critical: "bg-orange-50 text-orange-700", urgent: "bg-red-50 text-red-700", "out-of-stock": "bg-slate-800 text-white" };
function HealthBadge({ health }: { health: CommandCenterHealth }) { return <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${healthStyles[health]}`}>{health.replaceAll("-", " ")}</span>; }
