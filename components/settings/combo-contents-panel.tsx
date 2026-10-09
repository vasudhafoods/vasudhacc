"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BundleRecipe, BundleSetup } from "@/services/product-bundles";

type Row = { productId: string; quantity: string };

function displayName(name: string) {
  return name.replace(/\s*·\s*pack of 1\b/i, "");
}

export function ComboContentsPanel({ initial }: { initial: BundleSetup }) {
  const router = useRouter();
  const [setup, setSetup] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function startEdit(bundle: BundleRecipe) {
    setEditing(bundle.productId);
    setRows(bundle.components.length ? bundle.components.map((row) => ({ productId: row.productId, quantity: String(row.quantity) })) : [{ productId: "", quantity: "1" }]);
    setError(null);
    setSuccess(null);
  }

  async function save(bundle: BundleRecipe) {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const components = rows.filter((row) => row.productId).map((row) => ({ productId: row.productId, quantity: Number(row.quantity) }));
      const response = await fetch("/api/settings/bundles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleProductId: bundle.productId, components }),
      });
      const body = await response.json() as Partial<BundleSetup> & { error?: { message?: string } };
      if (!response.ok || !body.bundles || !body.units) throw new Error(body.error?.message ?? "Combo contents could not be saved.");
      setSetup({ bundles: body.bundles, units: body.units });
      setEditing(null);
      setSuccess(`${bundle.name} saved. Waiting Shopify orders for this combo will be deducted on the next sync.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Combo contents could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass = "h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";
  return <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="border-b border-slate-100 p-5 sm:p-6"><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Shopify orders</p><h2 className="mt-1 text-lg font-bold text-slate-950">Combo contents</h2><p className="mt-1 text-sm text-slate-500">List the individual packets inside one combo. When a combo is ordered on Shopify, each packet is deducted from Online stock.</p></div>
    <div className="space-y-4 p-5 sm:p-6">
      {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{error}</div> : null}
      {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status">{success}</div> : null}
      {setup.bundles.length ? setup.bundles.map((bundle) => <div key={bundle.productId} className="rounded-xl border border-slate-200 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><p className="font-semibold text-slate-900">{bundle.name}</p><p className="text-xs text-slate-500">SKU {bundle.sku}</p>
            {editing !== bundle.productId ? bundle.components.length
              ? <ul className="mt-2 space-y-1 text-sm text-slate-700">{bundle.components.map((row) => <li key={row.productId}>{row.quantity} × {displayName(row.name)}</li>)}</ul>
              : <p className="mt-2 text-sm font-semibold text-amber-700">No contents yet — Shopify orders for this combo cannot be deducted.</p> : null}
          </div>
          {editing !== bundle.productId ? <button type="button" onClick={() => startEdit(bundle)} className="h-10 shrink-0 rounded-lg border border-emerald-700 px-4 text-sm font-bold text-emerald-800">{bundle.components.length ? "Edit contents" : "Add contents"}</button> : null}
        </div>
        {editing === bundle.productId ? <div className="mt-4 space-y-3">
          {rows.map((row, index) => <div key={index} className="flex gap-2">
            <select aria-label="Packet" className={`${inputClass} min-w-0 flex-1`} value={row.productId} onChange={(event) => setRows(rows.map((item, i) => i === index ? { ...item, productId: event.target.value } : item))}>
              <option value="">Choose a packet…</option>
              {setup.units.map((unit) => <option key={unit.id} value={unit.id}>{displayName(unit.name)} ({unit.sku})</option>)}
            </select>
            <input aria-label="Quantity" type="number" min={1} max={1000} step={1} className={`${inputClass} w-20`} value={row.quantity} onChange={(event) => setRows(rows.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))}/>
            <button type="button" aria-label="Remove packet" onClick={() => setRows(rows.filter((_, i) => i !== index))} className="h-11 rounded-lg border border-slate-300 px-3 text-sm font-bold text-slate-600">✕</button>
          </div>)}
          <div className="flex flex-wrap justify-between gap-2">
            <button type="button" onClick={() => setRows([...rows, { productId: "", quantity: "1" }])} className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-bold text-slate-700">+ Add packet</button>
            <div className="flex gap-2"><button type="button" onClick={() => setEditing(null)} className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-bold text-slate-700">Cancel</button><button type="button" disabled={saving} onClick={() => save(bundle)} className="h-10 rounded-lg bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-60">{saving ? "Saving…" : "Save contents"}</button></div>
          </div>
        </div> : null}
      </div>) : <p className="text-sm text-slate-500">No combo products found. Products named Combo, Bundle, Variety, Assorted or Box appear here after a catalog sync.</p>}
    </div>
  </section>;
}
