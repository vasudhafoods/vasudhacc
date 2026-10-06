"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Inventory = {
  products: { id: string; name: string; sku: string }[];
  locations: { id: string; name: string }[];
  balances: { productId: string; warehouseLocationId: string; bucket: string; onHand: number; reserved: number }[];
  refreshedAt: string;
};

export function SalesInventory() {
  const [data, setData] = useState<Inventory | null>(null);
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true);
    try {
      const response = await fetch("/api/offline-sales/inventory", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Inventory could not be loaded.");
      setData(body); setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Inventory could not be loaded."); }
    finally { pending.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  const rows = data?.products.filter(product => `${product.name} ${product.sku}`.toLowerCase().includes(search.trim().toLowerCase())).flatMap(product => data.locations.filter(warehouse => !location || warehouse.id === location).map(warehouse => {
    const balances = data.balances.filter(row => row.productId === product.id && row.warehouseLocationId === warehouse.id);
    const stock = (bucket: string) => balances.filter(row => row.bucket === bucket).reduce((sum, row) => sum + row.onHand, 0);
    const reserved = balances.filter(row => row.bucket === "retail").reduce((sum, row) => sum + row.reserved, 0);
    return { product, warehouse, online: stock("online"), retail: stock("retail"), buffer: stock("buffer"), qc: stock("qc"), damaged: stock("damaged"), reserved, available: Math.max(0, stock("retail") - reserved) };
  })) ?? [];
  return <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
    <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-bold">Live inventory · View only</h2><p className="mt-1 text-xs text-slate-500">Warehouse stock refreshes every 30 seconds. Shopify shows the recorded online allocation. Available Retail excludes reserved orders.</p>{data ? <p className="mt-1 text-xs text-slate-500">Last updated {new Date(data.refreshedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p> : null}</div><button type="button" disabled={loading} onClick={() => void refresh()} className="rounded-lg border border-emerald-700 px-4 py-2 text-sm font-semibold text-emerald-800 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh inventory"}</button></div>
    {error ? <p role="alert" className="text-sm text-rose-700">{error}{data ? " Showing the last loaded stock; it may be out of date." : ""}</p> : null}
    <div className="flex flex-wrap gap-3"><label className="text-sm">Search product or SKU<input value={search} onChange={event => setSearch(event.target.value)} className="mt-1 block rounded-lg border border-slate-300 p-2"/></label><label className="text-sm">Warehouse<select value={location} onChange={event => setLocation(event.target.value)} className="mt-1 block rounded-lg border border-slate-300 p-2"><option value="">All warehouses</option>{data?.locations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-left text-sm"><thead className="bg-slate-50"><tr>{["Product / SKU", "Warehouse", "Shopify", "Retail", "Reserved Retail", "Available Retail", "Buffer", "QC", "Damaged", "Total"].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={`${row.product.id}-${row.warehouse.id}`} className="border-t border-slate-100"><td className="p-3 font-semibold">{row.product.name}<span className="block text-xs font-normal text-slate-500">{row.product.sku}</span></td><td className="p-3">{row.warehouse.name}</td>{[row.online, row.retail, row.reserved, row.available, row.buffer, row.qc, row.damaged, row.online + row.retail + row.buffer + row.qc + row.damaged].map((value, index) => <td key={index} className={`p-3 ${index === 3 ? "font-bold text-emerald-800" : ""}`}>{value}</td>)}</tr>)}</tbody></table></div>
    {!rows.length && !loading && !error ? <p className="text-sm text-slate-500">No products match these filters.</p> : null}
    <p className="text-xs text-slate-500">Total includes QC and damaged stock. Use Available Retail when preparing sales orders.</p>
  </section>;
}
