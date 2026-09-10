import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { StatusBadge } from "@/components/inventory/status-badge";
import { requireDashboardSession } from "@/lib/auth/authorization";
import { getPhysicalInventoryMovements, getPhysicalInventoryProduct } from "@/services/physical-inventory";

const labels: Record<string, string> = {
  opening_balance: "Opening balance",
  stock_received: "Stock received",
  shopify_sale: "Shopify sale",
  retail_issue: "Retail dispatch",
  channel_transfer: "Channel transfer",
  return: "Return received",
  damage: "Damage recorded",
  manual_adjustment: "Manual adjustment",
  cycle_count_adjustment: "Cycle count adjustment",
  kandi_dispatch: "Kandi dispatch",
  narsingi_receipt: "Narsingi receipt",
  shopify_reconciliation: "Shopify reconciliation",
};

export default async function InventoryDetail({ params }: { params: Promise<{ inventoryItemId: string }> }) {
  await requireDashboardSession();
  await connection();
  const { inventoryItemId } = await params;
  const [product, movements] = await Promise.all([getPhysicalInventoryProduct(inventoryItemId), getPhysicalInventoryMovements(inventoryItemId)]);
  if (!product) notFound();
  return <div className="space-y-6">
    <Link href="/inventory" className="text-xs font-semibold text-[#246552]">← Back to physical product inventory</Link>
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Database ledger detail</p><h1 className="mt-1 text-2xl font-semibold text-slate-900">{product.displayName}</h1><p className="mt-1 text-sm text-slate-500">SKU: {product.sku} · {product.locations.join(", ")}</p></div><StatusBadge status={product.status}/></div>
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-emerald-700">Actual physical stock</p><p className="mt-1 text-sm text-emerald-950">Individual packets held in the warehouse ledger. Shopify bundles, combo products, and pack formats are excluded.</p></div><div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6"><Metric label="Actual packets" value={product.actual} strong/><Metric label="Online" value={product.online}/><Metric label="Retail" value={product.retail}/><Metric label="Buffer" value={product.buffer}/><Metric label="QC" value={product.qc}/><Metric label="Damaged" value={product.damaged}/></div></section>
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="border-b border-slate-100 p-5"><h2 className="text-base font-bold text-slate-900">Product stock history</h2><p className="mt-1 text-xs leading-5 text-slate-500">Every change is from the command-center ledger. This is the audit trail for this physical product.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">When</th><th className="px-3 py-3">Movement</th><th className="px-3 py-3">Location / bucket</th><th className="px-3 py-3">Reference</th><th className="px-3 py-3 text-right">Change</th><th className="px-5 py-3 text-right">Closing balance</th></tr></thead><tbody>{movements.map((movement) => <tr key={movement.id} className="border-t border-slate-100 text-slate-600"><td className="px-5 py-3">{new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(movement.occurredAt))}</td><td className="px-3 py-3"><p className="font-semibold text-slate-800">{labels[movement.type] ?? movement.type}</p><p className="mt-1 text-[10px] text-slate-400">{movement.reason}</p></td><td className="px-3 py-3">{movement.locationName}<span className="block capitalize text-slate-400">{movement.bucket}</span></td><td className="px-3 py-3">{movement.referenceId ?? movement.transactionNumber}</td><td className={`px-3 py-3 text-right font-bold ${movement.quantityDelta > 0 ? "text-emerald-700" : "text-rose-700"}`}>{movement.quantityDelta > 0 ? "+" : ""}{movement.quantityDelta}</td><td className="px-5 py-3 text-right font-bold text-slate-800">{movement.closingBalance}</td></tr>)}</tbody></table></div>{!movements.length ? <div className="p-8 text-center text-sm text-slate-500">No ledger movements are recorded for this product yet.</div> : null}</section>
  </div>;
}

function Metric({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className="rounded-xl border border-emerald-100 bg-white p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">{label}</p><p className={`mt-1 ${strong ? "text-3xl" : "text-xl"} font-bold text-slate-900`}>{value}</p></div>;
}
