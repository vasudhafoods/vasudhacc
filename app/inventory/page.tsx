import { connection } from "next/server";
import { PhysicalInventoryTable } from "@/components/inventory/physical-inventory-table";
import { requireDashboardSession } from "@/lib/auth/authorization";
import { getPhysicalInventoryProducts } from "@/services/physical-inventory";

export default async function InventoryPage() {
  await requireDashboardSession();
  await connection();
  const products = await getPhysicalInventoryProducts();
  const totalPackets = products.reduce((sum, product) => sum + product.actual, 0);
  const attentionProducts = products.filter((product) => product.actual < 100 || (product.earliestExpiryDate && new Date(product.earliestExpiryDate).getTime() <= Date.now() + 60 * 24 * 60 * 60 * 1000));
  const lastUpdated = products.reduce<Date | null>((latest, product) => {
    const updated = new Date(product.updatedAt);
    return !latest || updated > latest ? updated : latest;
  }, null);
  return <div className="space-y-6">
    <div><p className="text-xs font-medium text-[#2d725f]">Inventory</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Physical product inventory</h1><p className="mt-1 text-sm text-slate-500">The database ledger is the source of truth for individual packets. Shopify is used only to sell online packs and bundles; it does not control this physical stock list.</p></div>
    <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-sm font-bold text-emerald-950"><span className="size-2 rounded-full bg-emerald-500"/>DATABASE LEDGER</div><p className="mt-2 text-sm text-emerald-900">Receipts, warehouse transfers, retail dispatches, returns, QC decisions, and stock adjustments update these balances immediately.</p></div><div className="grid grid-cols-2 gap-3 text-right"><div><p className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">Physical products</p><p className="mt-1 text-2xl font-bold text-emerald-950">{products.length}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">Total packets</p><p className="mt-1 text-2xl font-bold text-emerald-950">{totalPackets}</p></div></div></div><p className="mt-4 border-t border-emerald-200 pt-3 text-xs text-emerald-800">{lastUpdated ? `Last ledger update: ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(lastUpdated)}.` : "No physical stock has been entered yet. Start with a warehouse receipt."} Bundles, combo boxes, and Shopify pack listings are not shown here.</p></section>
    {attentionProducts.length ? <section className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h2 className="font-bold text-amber-950">Stock and expiry alerts ({attentionProducts.length})</h2><ul className="mt-2 space-y-1 text-sm text-amber-900">{attentionProducts.map((product) => <li key={product.id}>{product.name}: {product.actual === 0 ? "Out of stock" : product.actual < 100 ? `Low stock (${product.actual})` : ""}{product.earliestExpiryDate && new Date(product.earliestExpiryDate).getTime() <= Date.now() + 60 * 24 * 60 * 60 * 1000 ? ` · expiry ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(product.earliestExpiryDate))}` : ""}</li>)}</ul><p className="mt-2 text-xs text-amber-800">Review with Vamshi and Sales. Email or WhatsApp notifications require recipient/channel configuration in Settings.</p></section> : null}
    <PhysicalInventoryTable products={products}/>
  </div>;
}
