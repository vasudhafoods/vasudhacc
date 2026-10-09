"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { discountPercent, discountFromPercent } from "@/lib/sales/discount-percent";
import { calculateInvoice } from "@/lib/sales/invoice-calc";
import type { OfflineSaleRow, OfflineSalesEntryData } from "@/types/offline-sales";

type Document = { id: string; fileName: string; createdAt: string };
type Snapshot = OfflineSaleRow & { updatedAt: string; invoiceDocuments?: Document[] };
type History = { id: string; action: string; actor: string; reason: string; editedAt: string; before: Snapshot; after: Snapshot };
type Details = { sale: Snapshot; documents: Document[]; history: History[] };
type DraftLine = { productId: string; quantity: string; price: string; gst: string; discount: string };
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value / 100);
const time = (value: string) => new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const input = "mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm";
const date = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

export function OrderAmendments({ sale, products }: { sale: OfflineSaleRow; products: OfflineSalesEntryData["products"] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"edit" | "cancel" | "history" | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const endpoint = `/api/offline-sales/${sale.id}/amendments`;

  async function open(next: "edit" | "cancel" | "history") {
    setBusy(true); setError(""); setNotice(""); setMode(null); setDetails(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Could not load order.");
      const loaded = body as Details;
      setDetails(loaded);
      setLines(loaded.sale.lines.map(line => ({ productId: line.productId ?? "", quantity: String(line.quantity), price: (line.unitPricePaisa / 100).toFixed(2), gst: String((line.gstRateBps ?? 0) / 100), discount: discountPercent(line.quantity * line.unitPricePaisa, line.discountPaisa ?? 0) })));
      setMode(next);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load order."); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details || (mode !== "edit" && mode !== "cancel")) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const toPaisa = (value: string) => {
        if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error("Enter currency amounts with up to two decimal places.");
        return Math.round(Number(value) * 100);
      };
      const fields = Object.fromEntries(data.entries());
      const payload = { ...fields, action: mode, expectedVersion: details.sale.updatedAt, shippingSameAsBilling: data.get("shippingSameAsBilling") === "on", ...(mode === "edit" ? { lines: lines.map(line => ({ productId: line.productId, quantity: Number(line.quantity), unitPricePaisa: toPaisa(line.price), gstRateBps: Math.round(Number(line.gst) * 100), discountPaisa: discountFromPercent(Number(line.quantity) * toPaisa(line.price), line.discount) })) } : {}) };
      const form = new FormData(); form.set("data", JSON.stringify(payload));
      const invoice = data.get("invoice"); if (invoice instanceof File && invoice.size) form.set("invoice", invoice);
      const response = await fetch(endpoint, { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Order could not be updated.");
      setNotice(mode === "cancel" ? "Order cancelled. The record and cancellation note are retained." : "Correction saved. The previous order and invoice remain in revision history.");
      setMode(null); setDetails(null); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Order could not be updated."); }
    finally { setBusy(false); }
  }
  function update(index: number, key: keyof DraftLine, value: string) {
    setLines(current => current.map((line, i) => i === index ? { ...line, [key]: value, ...(key === "productId" ? { price: ((products.find(product => product.id === value)?.unitPricePaisa ?? 0) / 100).toFixed(2) } : {}) } : line));
  }
  const current = details?.sale;
  return <div className="mt-4 border-t border-slate-100 pt-3">
    <div className="flex flex-wrap items-center gap-4 text-xs">
      {sale.deliveryStatus === "packing" ? <><button disabled={busy} type="button" onClick={() => open("edit")} className="font-semibold text-blue-800 underline">Edit invoice / order</button><button disabled={busy} type="button" onClick={() => open("cancel")} className="font-semibold text-rose-700 underline">Cancel order</button></> : null}
      <button disabled={busy} type="button" onClick={() => open("history")} className="text-slate-600 underline">{sale.correctionCount ?? 0} corrections · View history</button>
      {sale.lastCorrectedAt ? <span className="text-slate-500">Last edited {time(sale.lastCorrectedAt)} IST</span> : null}
      {busy ? <span role="status">Working…</span> : null}
    </div>
    {sale.cancellationNote ? <p className="mt-2 text-sm text-rose-800">Cancellation note: {sale.cancellationNote}</p> : null}
    {sale.deliveryStatus === "cancelled" && sale.collectedAmountPaisa > 0 ? <p className="mt-2 text-sm text-amber-800">Recorded payment {money(sale.collectedAmountPaisa)} retained. Ask Management to reconcile any refund.</p> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-rose-700">{error}</p> : null}
    {notice ? <p role="status" className="mt-2 text-sm text-emerald-800">{notice}</p> : null}
    {mode && details && current ? <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 flex items-center justify-between"><h4 className="font-bold">{mode === "edit" ? "Correct invoice / order" : mode === "cancel" ? "Cancel order" : "Order revision history"}</h4><button type="button" disabled={busy} onClick={() => { setMode(null); setError(""); }} className="text-sm underline">Close</button></div>
      {mode === "history" ? <>
        <p className="mb-3 text-xs text-slate-600">{details.history.filter(event => event.action === "offline_sale.corrected").length} corrections. Times shown in IST.</p>
        {!details.history.length ? <p className="text-sm">No corrections or cancellations have been recorded.</p> : null}
        {details.history.map((event, index) => <div key={event.id} className="mb-3 rounded-lg border bg-white p-3"><p className="text-sm font-semibold">{event.action === "offline_sale.cancelled" ? "Cancelled" : `Correction ${details.history.slice(0, index + 1).filter(row => row.action === "offline_sale.corrected").length}`} · {time(event.editedAt)} IST · {event.actor}</p><p className="mt-1 text-sm">{event.reason}</p><details className="mt-2"><summary className="cursor-pointer text-xs text-blue-800 underline">Explore order before edit</summary><OrderSnapshot sale={event.before}/></details><details className="mt-2"><summary className="cursor-pointer text-xs text-blue-800 underline">View saved version after change</summary><OrderSnapshot sale={event.after}/></details></div>)}
      </> : <form onSubmit={save} className="space-y-4"><fieldset disabled={busy} className="space-y-4">
        {mode === "cancel" ? <><p className="text-sm">Cancel this order and release its reserved stock. The order will remain in the database.</p>{sale.collectedAmountPaisa > 0 ? <p className="text-sm text-amber-800">Payments of {money(sale.collectedAmountPaisa)} are retained; cancellation does not issue a refund.</p> : null}</> : <>
          <p className="text-xs text-slate-600">Edits are allowed before dispatch. Existing payments and the preparing warehouse stay attached to this order. Discount percentages below include any original invoice discount.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Invoice number<input name="billingInvoiceNumber" defaultValue={current.billingInvoiceNumber ?? "NA"} className={input} required minLength={2} maxLength={100}/></label>
            <label className="text-sm">Invoice date<input name="saleDate" type="date" defaultValue={date(current.saleDate)} className={input} required/></label>
            <label className="text-sm">Customer<input name="customerName" defaultValue={current.customerName} className={input} required minLength={2} maxLength={160}/></label>
            <label className="text-sm">Company<input name="customerCompanyName" defaultValue={current.customerCompanyName ?? ""} className={input} maxLength={160}/></label>
            <label className="text-sm">Contact<input name="customerContact" defaultValue={current.customerContact ?? ""} className={input} maxLength={80}/></label>
            <label className="text-sm">GSTIN<input name="gstNumber" defaultValue={current.gstNumber ?? ""} className={input} maxLength={15}/></label>
            <label className="text-sm">Billing address<textarea name="billingAddress" defaultValue={current.billingAddress} className={input} required minLength={5} maxLength={500}/></label>
            <label className="text-sm">Shipping address<textarea name="shippingAddress" defaultValue={current.shippingAddress} className={input} maxLength={500}/></label>
            <label className="text-sm"><input name="shippingSameAsBilling" type="checkbox" defaultChecked={current.shippingSameAsBilling}/> Shipping same as billing</label>
            <label className="text-sm">Requested dispatch date<input name="requestedDispatchDate" type="date" defaultValue={current.requestedDispatchDate ?? ""} className={input}/></label>
          </div>
          {lines.map((line, index) => <div key={index} className="grid gap-2 rounded-lg border bg-white p-3 sm:grid-cols-3 lg:grid-cols-6">
            <label className="text-xs">Product<select value={line.productId} onChange={event => update(index, "productId", event.target.value)} className={input} required><option value="">Select product</option>{!products.some(product => product.id === line.productId) && line.productId ? <option value={line.productId}>{current.lines.find(item => item.productId === line.productId)?.productName}</option> : null}{products.map(product => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></label>
            <label className="text-xs">Quantity<input className={input} type="number" min="1" step="1" required value={line.quantity} onChange={event => update(index, "quantity", event.target.value)}/></label>
            <label className="text-xs">Unit price ₹<input className={input} type="number" min="0.01" step="0.01" required value={line.price} onChange={event => update(index, "price", event.target.value)}/></label>
            <label className="text-xs">GST %<input className={input} type="number" min="0" max="28" step="0.01" required value={line.gst} onChange={event => update(index, "gst", event.target.value)}/></label>
            <label className="text-xs">Discount %<input className={input} type="number" min="0" max="100" step="any" required value={line.discount} onChange={event => update(index, "discount", event.target.value)}/></label>
            <button type="button" disabled={lines.length === 1} onClick={() => setLines(current => current.filter((_, i) => i !== index))} className="text-xs text-rose-700 underline disabled:opacity-40">Remove line</button>
          </div>)}
          <button type="button" disabled={lines.length >= 50} onClick={() => setLines(current => [...current, { productId: "", quantity: "1", price: "", gst: "0", discount: "0" }])} className="text-sm text-blue-800 underline">+ Add product line</button>
          <p className="text-sm font-bold">Corrected total: {money(calculateInvoice(lines.map(line => ({ quantity: Math.max(0, Math.floor(Number(line.quantity) || 0)), unitPricePaisa: Math.round((Number(line.price) || 0) * 100), gstRateBps: Math.round((Number(line.gst) || 0) * 100), discountPaisa: discountFromPercent(Math.max(0, Math.floor(Number(line.quantity) || 0)) * Math.round((Number(line.price) || 0) * 100), String(Math.min(100, Math.max(0, Number(line.discount) || 0)))) }))).totalAmountPaisa)}</p>
          <label className="block text-sm">Order notes<textarea name="notes" defaultValue={current.notes ?? ""} maxLength={1000} className={input}/></label>
          <label className="block text-sm">Replacement invoice (optional)<input name="invoice" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className={input}/><span className="text-xs text-slate-500">Up to 3 MB. Earlier invoice files are retained.</span></label>
          {details.documents.map(doc => <a key={doc.id} className="mr-3 inline-block text-xs text-blue-800 underline" href={`/api/offline-sales/${sale.id}/documents/${doc.id}`} target="_blank" rel="noreferrer">{doc.fileName} · {time(doc.createdAt)}</a>)}
        </>}
        <label className="block text-sm font-semibold">{mode === "cancel" ? "Cancellation note" : "Reason for correction"}<textarea name="reason" className={input} required minLength={3} maxLength={1000} placeholder={mode === "cancel" ? "Created by mistake — explain what happened" : "Explain what changed and why"}/></label>
        <button type="submit" className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${mode === "cancel" ? "bg-rose-700" : "bg-emerald-800"}`}>{busy ? "Saving…" : mode === "cancel" ? "Confirm cancellation" : "Save correction"}</button>
      </fieldset></form>}
    </div> : null}
  </div>;
}

function OrderSnapshot({ sale }: { sale: Snapshot }) {
  return <div className="mt-3 space-y-2 text-sm">
    <p><strong>{sale.billingInvoiceNumber || sale.saleNumber}</strong> · {date(sale.saleDate)} · {sale.deliveryStatus}</p>
    <p>{sale.customerName}{sale.customerCompanyName ? ` · ${sale.customerCompanyName}` : ""} · {sale.customerContact || "No contact"}</p>
    <p>Billing: {sale.billingAddress}</p><p>Shipping: {sale.shippingAddress}</p><p>GSTIN: {sale.gstNumber || "—"}</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Product / SKU</th><th>Qty</th><th>Unit price</th><th>GST</th><th>Discount</th></tr></thead><tbody>{sale.lines.map((line, index) => <tr key={index}><td>{line.productName} · {line.sku}</td><td>{line.quantity}</td><td>{money(line.unitPricePaisa)}</td><td>{(line.gstRateBps ?? 0) / 100}%</td><td>{money(line.discountPaisa ?? 0)}</td></tr>)}</tbody></table></div>
    <p>Subtotal {money(sale.subtotalAmountPaisa)} · Discount {money(sale.discountPaisa)} · GST {money(sale.taxPaisa)} · <strong>Total {money(sale.totalAmountPaisa)}</strong></p>
    <p>Recorded payments: {money(sale.collectedAmountPaisa ?? 0)}</p><p>Requested dispatch: {sale.requestedDispatchDate || "—"}</p><p>Notes: {sale.notes || "—"}</p>
    {sale.invoiceDocuments?.map(doc => <a key={doc.id} href={`/api/offline-sales/${sale.id}/documents/${doc.id}`} target="_blank" rel="noreferrer" className="mr-3 inline-block text-xs text-blue-800 underline">Invoice: {doc.fileName} · {time(doc.createdAt)}</a>)}
  </div>;
}
