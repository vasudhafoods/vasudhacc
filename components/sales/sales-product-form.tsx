"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function SalesProductForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const input = "mt-1 block h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const price = String(data.get("price") ?? "").trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
      setError("Enter a price greater than zero with up to two decimal places.");
      return;
    }
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/offline-sales/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.get("name"), sku: data.get("sku"), category: data.get("category"), unitPricePaisa: Math.round(Number(price) * 100) }),
      });
      const body = await response.json() as { product?: { id: string; name: string }; error?: { message?: string } };
      if (!response.ok || !body.product) throw new Error(body.error?.message ?? "Product could not be saved.");
      let shopifyNote = " It is retail only (not on Shopify).";
      if (data.get("shopify") === "on") {
        const listed = await fetch(`/api/warehouse/products/${body.product.id}/shopify`, { method: "POST" });
        const listedBody = await listed.json() as { error?: { message?: string } };
        shopifyNote = listed.ok
          ? " It was also added to Shopify. Add images and make it available on the Online Store in Shopify admin to start selling."
          : ` It was not added to Shopify: ${listedBody.error?.message ?? "Shopify request failed."} Warehouse can add it from Receive stock.`;
      }
      setNotice(`${body.product.name} saved to the shared catalog. Warehouse can now receive stock for it.${shopifyNote}`);
      form.reset(); setOpen(false); router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Product could not be saved.");
    } finally { setSaving(false); }
  }

  return <section className="rounded-xl border border-slate-200 bg-white p-4">
    <button type="button" className="font-semibold text-emerald-800" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Close new product form" : "+ Create new product"}</button>
    {notice ? <p role="status" className="mt-3 text-sm text-emerald-800">{notice}</p> : null}
    {open ? <form onSubmit={save} className="mt-4 space-y-4">
      <p className="text-sm text-slate-600">Save a new product for both Sales and Warehouse. Use a unique SKU.</p>
      {error ? <p role="alert" className="text-sm text-rose-700">{error}</p> : null}
      <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-semibold">Product name<input name="name" className={input} required minLength={2} maxLength={200}/></label>
        <label className="text-sm font-semibold">SKU<input name="sku" className={input} required minLength={2} maxLength={60}/></label>
        <label className="text-sm font-semibold">Category<select name="category" className={input} defaultValue="other"><option value="noodles">Noodles</option><option value="cookies">Cookies</option><option value="rte">RTE</option><option value="other">Other</option></select></label>
        <label className="text-sm font-semibold">Unit price / MRP ₹<input name="price" className={input} type="number" required min="0.01" step="0.01"/></label>
      </fieldset>
      <label className="flex items-start gap-2 text-sm text-slate-700"><input name="shopify" type="checkbox" className="mt-0.5 size-4 accent-emerald-700" disabled={saving}/><span><strong>Also add to Shopify</strong> to sell online. Leave unticked for retail-only products such as chikkis.</span></label>
      <button disabled={saving} className="rounded-lg bg-emerald-800 px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save product"}</button>
    </form> : null}
  </section>;
}
