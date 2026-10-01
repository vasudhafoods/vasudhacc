"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { OfflineSaleRow, OfflineSalesEntryData, OfflineSalesOverview } from "@/types/offline-sales";

type Line = { productId: string; quantity: string; unitPrice: string; gstRate: string; discount: string };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const money = (paisa: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paisa / 100);
const paisa = (value: string) => /^\d+(?:\.\d{1,2})?$/.test(value.trim()) ? Math.round(Number(value) * 100) : 0;
const input = "mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";
const freshLine = (): Line => ({ productId: "", quantity: "1", unitPrice: "", gstRate: "0", discount: "0" });

export function SalesOrderWorkspace({ overview, entryData }: { overview: OfflineSalesOverview; entryData: OfflineSalesEntryData }) {
  const router = useRouter();
  const [date, setDate] = useState(today);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [customer, setCustomer] = useState("");
  const [contact, setContact] = useState("");
  const [billing, setBilling] = useState("");
  const [sameAddress, setSameAddress] = useState(true);
  const [shipping, setShipping] = useState("");
  const [gstin, setGstin] = useState("");
  const [locationId, setLocationId] = useState(entryData.locations[0]?.id ?? "");
  const [lines, setLines] = useState<Line[]>([freshLine()]);
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState("upi");
  const [transactionId, setTransactionId] = useState("");
  const [receiver, setReceiver] = useState("");
  const [nextPaymentDate, setNextPaymentDate] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => lines.reduce((sum, line) => {
    const quantity = Number(line.quantity) || 0;
    const base = quantity * paisa(line.unitPrice);
    const discount = Math.min(base, paisa(line.discount));
    const tax = Math.round((base - discount) * Number(line.gstRate || 0) / 100);
    return { subtotal: sum.subtotal + base, discount: sum.discount + discount, tax: sum.tax + tax, total: sum.total + base - discount + tax };
  }, { subtotal: 0, discount: 0, tax: 0, total: 0 }), [lines]);
  const paymentPaisa = paisa(paymentAmount);
  const available = (productId: string) => entryData.retailBalances.find((row) => row.productId === productId && row.warehouseLocationId === locationId)?.available ?? 0;

  function updateLine(index: number, key: keyof Line, value: string) {
    setLines(current => current.map((line, i) => i === index ? { ...line, [key]: value, ...(key === "productId" ? { unitPrice: ((entryData.products.find(p => p.id === value)?.unitPricePaisa ?? 0) / 100).toFixed(2) } : {}) } : line));
  }
  async function upload(saleId: string, kind: "invoice" | "payment_proof", file: File) {
    const form = new FormData(); form.set("kind", kind); form.set("file", file);
    const response = await fetch(`/api/offline-sales/${saleId}/documents`, { method: "POST", body: form });
    const body = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? `${kind === "invoice" ? "Invoice" : "Payment proof"} upload failed.`);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      if (!invoiceFile) throw new Error("Upload the invoice copy.");
      if (paymentPaisa > totals.total) throw new Error("Payment received cannot exceed the invoice total.");
      if (paymentPaisa > 0 && (!proof || !receiver || (paymentMode !== "cash" && !transactionId))) throw new Error("For a payment, enter receiver and mode, attach proof, and provide transaction ID for non-cash payments.");
      if (paymentPaisa > 0 && paymentPaisa < totals.total && !nextPaymentDate) throw new Error("Set the expected date for the next partial payment.");
      const preparedLines = lines.map(line => {
        const product = entryData.products.find(item => item.id === line.productId);
        const quantity = Number(line.quantity);
        if (!product || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Choose a product and valid quantity for every line.");
        if (quantity > available(product.id)) throw new Error(`${product.name} has only ${available(product.id)} Retail packets available at the selected warehouse.`);
        return { productId: product.id, productName: product.name, sku: product.sku, quantity, unitPricePaisa: paisa(line.unitPrice), gstRateBps: Number(line.gstRate) * 100, discountPaisa: paisa(line.discount) };
      });
      if (new Set(preparedLines.map(line => line.productId)).size !== preparedLines.length) throw new Error("Use one line per product; combine quantities on the same line.");
      const response = await fetch("/api/offline-sales", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ saleDate: date, billingInvoiceNumber: invoiceNo, invoiceFileName: invoiceFile.name, customerName: customer, customerContact: contact || undefined, billingAddress: billing, shippingSameAsBilling: sameAddress, shippingAddress: sameAddress ? billing : shipping, gstNumber: gstin || undefined, customerType: "retail", isNewB2bCustomer: false, warehouseLocationId: locationId, initialCollectionPaisa: paymentPaisa, paymentMode: paymentPaisa ? paymentMode : undefined, paymentTransactionId: transactionId || undefined, paymentReceiverName: receiver || undefined, paymentProofFileName: proof?.name, expectedNextPaymentDate: nextPaymentDate || undefined, lines: preparedLines }) });
      const result = await response.json() as { result?: { sale?: OfflineSaleRow }; error?: { message?: string } };
      if (!response.ok || !result.result?.sale) throw new Error(result.error?.message ?? "Order could not be saved.");
      const sale = result.result.sale;
      const uploadIssues: string[] = [];
      try { await upload(sale.id, "invoice", invoiceFile); } catch (e) { uploadIssues.push(e instanceof Error ? e.message : "Invoice upload failed."); }
      if (paymentPaisa > 0 && proof) try { await upload(sale.id, "payment_proof", proof); } catch (e) { uploadIssues.push(e instanceof Error ? e.message : "Payment proof upload failed."); }
      setNotice(`${sale.billingInvoiceNumber} submitted to warehouse. Total ${money(sale.totalAmountPaisa)} · ${sale.paymentStatus} payment.${uploadIssues.length ? ` Order saved; ${uploadIssues.join(" ")}` : " Invoice and payment documents uploaded."}`);
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Order could not be submitted."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    <section className="rounded-2xl bg-[#174f40] p-6 text-white"><p className="text-xs font-semibold uppercase tracking-[.16em] text-emerald-200">Retail sales</p><h1 className="mt-2 text-3xl font-bold">Create a customer order</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-50">Orders are sent directly to the warehouse queue. Retail stock is reserved when the order is submitted and issued when Warehouse marks it dispatched.</p></section>
    {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p> : null}
    {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</p> : null}
    <form onSubmit={submit} className="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <section><h2 className="text-lg font-bold text-slate-900">Invoice and customer</h2><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm font-semibold">Order date<input className={input} type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label>
        <label className="text-sm font-semibold">Biiing invoice number<input className={input} value={invoiceNo} onChange={e=>setInvoiceNo(e.target.value)} required minLength={2} maxLength={100}/></label>
        <label className="text-sm font-semibold">Invoice to / customer name<input className={input} value={customer} onChange={e=>setCustomer(e.target.value)} required minLength={2}/></label>
        <label className="text-sm font-semibold">Phone / contact<input className={input} value={contact} onChange={e=>setContact(e.target.value)} placeholder="Customer contact"/></label>
        <label className="text-sm font-semibold sm:col-span-2">Billing address<textarea className="mt-1.5 min-h-24 w-full rounded-lg border border-slate-300 p-3 text-sm" value={billing} onChange={e=>setBilling(e.target.value)} required minLength={5}/></label>
        <label className="text-sm font-semibold">GSTIN <span className="font-normal text-slate-500">optional</span><input className={input} value={gstin} onChange={e=>setGstin(e.target.value.toUpperCase())} maxLength={15} placeholder="15 character GSTIN"/></label>
        <label className="text-sm font-semibold">Preparing warehouse<select className={input} value={locationId} onChange={e=>setLocationId(e.target.value)} required>{entryData.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      </div><label className="mt-4 flex items-center gap-2 text-sm font-medium text-slate-700"><input type="checkbox" checked={sameAddress} onChange={e=>setSameAddress(e.target.checked)} className="size-4 accent-emerald-700"/>Shipping address is same as billing</label>{!sameAddress?<label className="mt-3 block text-sm font-semibold">Shipping address<textarea className="mt-1.5 min-h-24 w-full rounded-lg border border-slate-300 p-3 text-sm" value={shipping} onChange={e=>setShipping(e.target.value)} required minLength={5}/></label>:null}</section>
      <section className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold text-slate-900">Products</h2><p className="mt-1 text-xs text-slate-500">Prices are per packet. Stock availability uses the selected warehouse Retail bucket.</p></div><button type="button" onClick={()=>setLines(current=>[...current,freshLine()])} className="rounded-lg border border-blue-300 bg-white px-4 py-2 text-sm font-bold text-blue-800">+ Add product</button></div>
        <div className="mt-4 space-y-3">{lines.map((line,index)=><div key={index} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 xl:grid-cols-[minmax(210px,2fr)_90px_130px_100px_120px_100px_auto] xl:items-end">
          <label className="text-xs font-semibold text-slate-600">Product<select className={input} value={line.productId} onChange={e=>updateLine(index,"productId",e.target.value)} required><option value="">Select product</option>{entryData.products.map(p=><option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label>
          <label className="text-xs font-semibold text-slate-600">Qty<input className={input} type="number" min="1" step="1" value={line.quantity} onChange={e=>updateLine(index,"quantity",e.target.value)} required/></label>
          <label className="text-xs font-semibold text-slate-600">Unit price ₹<input className={input} type="number" min="0.01" step="0.01" value={line.unitPrice} onChange={e=>updateLine(index,"unitPrice",e.target.value)} required/></label>
          <label className="text-xs font-semibold text-slate-600">GST<select className={input} value={line.gstRate} onChange={e=>updateLine(index,"gstRate",e.target.value)}>{[0,5,12,18,28].map(x=><option key={x} value={x}>{x}%</option>)}</select></label>
          <label className="text-xs font-semibold text-slate-600">Discount ₹<input className={input} type="number" min="0" step="0.01" value={line.discount} onChange={e=>updateLine(index,"discount",e.target.value)}/></label>
          <div className="pb-2 text-xs text-slate-500">{line.productId?`${available(line.productId)} available`:"Stock —"}</div>
          <button type="button" disabled={lines.length===1} onClick={()=>setLines(current=>current.filter((_,i)=>i!==index))} className="h-11 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-600 disabled:opacity-40">Remove</button>
        </div>)}</div>
      </section>
      <section className="grid gap-5 lg:grid-cols-[1fr_320px]"><div className="rounded-xl border border-slate-200 p-4"><h2 className="font-bold text-slate-900">Invoice copy</h2><p className="mt-1 text-xs text-slate-500">PDF, JPG, PNG, or WebP; up to 3 MB.</p><input className="mt-3 block w-full text-sm" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e=>setInvoiceFile(e.target.files?.[0]??null)} required/></div><div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"><p className="flex justify-between"><span>Subtotal</span><b>{money(totals.subtotal)}</b></p><p className="mt-2 flex justify-between"><span>Discount</span><b>−{money(totals.discount)}</b></p><p className="mt-2 flex justify-between"><span>GST</span><b>{money(totals.tax)}</b></p><p className="mt-3 flex justify-between border-t pt-3 text-base"><span>Final amount</span><b>{money(totals.total)}</b></p></div></section>
      <section className="rounded-xl border border-slate-200 p-4"><h2 className="font-bold text-slate-900">Payment</h2><p className="mt-1 text-xs text-slate-500">Leave amount received as zero if payment is pending. Partial collections need an expected next payment date.</p><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><label className="text-sm font-semibold">Amount received now ₹<input className={input} type="number" min="0" step="0.01" value={paymentAmount} onChange={e=>setPaymentAmount(e.target.value)}/></label>{paymentPaisa>0?<><label className="text-sm font-semibold">Mode<select className={input} value={paymentMode} onChange={e=>setPaymentMode(e.target.value)}><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="cheque">Cheque</option><option value="other">Other</option></select></label><label className="text-sm font-semibold">Transaction ID {paymentMode==="cash"?"(optional)":""}<input className={input} value={transactionId} onChange={e=>setTransactionId(e.target.value)} required={paymentMode!=="cash"}/></label><label className="text-sm font-semibold">Received by<input className={input} value={receiver} onChange={e=>setReceiver(e.target.value)} required/></label><label className="text-sm font-semibold">Payment proof<input className={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e=>setProof(e.target.files?.[0]??null)} required/></label>{paymentPaisa<totals.total?<label className="text-sm font-semibold">Next payment expected<input className={input} type="date" value={nextPaymentDate} onChange={e=>setNextPaymentDate(e.target.value)} required/></label>:null}</>:null}</div><p className="mt-3 text-sm font-semibold text-slate-700">Status: {paymentPaisa<=0?"Pending":paymentPaisa>=totals.total?"Paid":"Partially paid"} · Remaining {money(Math.max(0,totals.total-paymentPaisa))}</p></section>
      <div className="flex justify-end"><button type="submit" disabled={busy||!entryData.locations.length||!entryData.products.length} className="h-12 rounded-xl bg-[#174f40] px-6 text-sm font-bold text-white disabled:opacity-50">{busy?"Submitting order…":"Submit order to warehouse →"}</button></div>
    </form>
    <section className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex justify-between"><div><h2 className="font-bold text-slate-900">Today’s submitted orders</h2><p className="mt-1 text-xs text-slate-500">{overview.salesCount} sales invoices · {money(overview.openReceivablesPaisa)} outstanding</p></div></div>{overview.recentSales.length?<div className="mt-4 divide-y divide-slate-100">{overview.recentSales.map(s=><article key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-semibold text-slate-800">{s.customerName} · {s.billingInvoiceNumber}</p><p className="mt-1 text-xs text-slate-500">{s.lines.map(l=>`${l.productName} × ${l.quantity}`).join(" · ")}</p></div><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold capitalize text-blue-800">{s.deliveryStatus}</span></article>)}</div>:<p className="mt-4 text-sm text-slate-500">No orders yet today.</p>}</section>
  </div>;
}
