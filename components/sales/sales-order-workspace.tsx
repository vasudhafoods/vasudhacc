"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { SalesProductForm } from "./sales-product-form";
import type { OfflineSaleRow, OfflineSalesEntryData, OfflineSalesOverview, SalesCustomer } from "@/types/offline-sales";

type Line = { productId: string; quantity: string; unitPrice: string; gstRate: string; discount: string };
type SalesWorkspaceTab = "create" | "orders";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const money = (paisa: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paisa / 100);
const paisa = (value: string) => /^\d+(?:\.\d{1,2})?$/.test(value.trim()) ? Math.round(Number(value) * 100) : 0;
const percentageDiscountPaisa = (basePaisa: number, percent: string) => Math.round(basePaisa * (Number(percent) || 0) / 100);
const input = "mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";
const freshLine = (): Line => ({ productId: "", quantity: "1", unitPrice: "", gstRate: "0", discount: "0" });

export function SalesOrderWorkspace({ overview, entryData }: { overview: OfflineSalesOverview; entryData: OfflineSalesEntryData }) {
  const router = useRouter();
  const invoiceInputRef = useRef<HTMLInputElement>(null);
  const proofInputRef = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(today);
  const [requestedDispatchDate, setRequestedDispatchDate] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [customer, setCustomer] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [customers, setCustomers] = useState(entryData.customers);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerCompany, setNewCustomerCompany] = useState("");
  const [newCustomerAddress, setNewCustomerAddress] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newCustomerGst, setNewCustomerGst] = useState("");
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const [contact, setContact] = useState("");
  const [billing, setBilling] = useState("");
  const [sameAddress, setSameAddress] = useState(true);
  const [shipping, setShipping] = useState("");
  const [gstin, setGstin] = useState("");
  const [locationId, setLocationId] = useState(entryData.locations[0]?.id ?? "");
  const [lines, setLines] = useState<Line[]>([freshLine()]);
  const [invoiceDiscountMode, setInvoiceDiscountMode] = useState<"percent" | "amount">("percent");
  const [invoiceDiscountInput, setInvoiceDiscountInput] = useState("0");
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
  const [activeTab, setActiveTab] = useState<SalesWorkspaceTab>("create");

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function selectCustomer(customerId: string) {
    setSelectedCustomerId(customerId);
    const saved = customers.find((item) => item.id === customerId);
    if (!saved) return;
    setCustomer(saved.name);
    setCompanyName(saved.companyName ?? "");
    setBilling(saved.address);
    setShipping(saved.address);
    setContact(saved.phone);
    setGstin(saved.gstNumber ?? "");
    setSameAddress(true);
  }

  async function createCustomer() {
    if (!newCustomerName.trim() || !newCustomerPhone.trim() || newCustomerAddress.trim().length < 5) {
      setCustomerError("Customer name, phone number, and address (at least 5 characters) are required.");
      return;
    }
    setSavingCustomer(true);
    setCustomerError("");
    setNotice("");
    try {
      const response = await fetch("/api/offline-sales/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCustomerName, companyName: newCustomerCompany, address: newCustomerAddress, phone: newCustomerPhone, gstNumber: newCustomerGst }),
      });
      const body = await response.json().catch(() => null) as { customer?: SalesCustomer; error?: { message?: string } } | null;
      if (!body) throw new Error(`Server returned an invalid response (${response.status}). Check that the latest app and database migration are deployed, then try again.`);
      if (!response.ok || !body.customer) throw new Error(body.error?.message ?? "Customer could not be saved.");
      setCustomers((current) => [body.customer!, ...current]);
      setNewCustomerName(""); setNewCustomerCompany(""); setNewCustomerAddress(""); setNewCustomerPhone(""); setNewCustomerGst("");
      setSelectedCustomerId(body.customer.id);
      setCustomer(body.customer.name); setCompanyName(body.customer.companyName ?? ""); setBilling(body.customer.address); setShipping(body.customer.address); setContact(body.customer.phone); setGstin(body.customer.gstNumber ?? ""); setSameAddress(true);
      setShowCustomerForm(false);
      setNotice(`${body.customer.companyName || body.customer.name} saved and selected for this order.`);
    } catch (caught) {
      setCustomerError(caught instanceof Error ? caught.message : "Customer could not be saved.");
    } finally {
      setSavingCustomer(false);
    }
  }

  const totals = useMemo(() => {
    const values = lines.map((line) => {
      const base = (Number(line.quantity) || 0) * paisa(line.unitPrice);
      const lineDiscount = Math.min(base, percentageDiscountPaisa(base, line.discount));
      return { base, lineDiscount, taxable: Math.max(0, base - lineDiscount), gstRate: Number(line.gstRate || 0) };
    });
    const subtotal = values.reduce((sum, line) => sum + line.base, 0);
    const productDiscount = values.reduce((sum, line) => sum + line.lineDiscount, 0);
    const discountable = Math.max(0, subtotal - productDiscount);
    const entered = Number(invoiceDiscountInput) || 0;
    const invoiceDiscount = invoiceDiscountMode === "percent"
      ? Math.min(discountable, Math.round(discountable * Math.min(100, Math.max(0, entered)) / 100))
      : Math.min(discountable, paisa(invoiceDiscountInput));
    const shares = values.map((line) => discountable ? Math.floor(invoiceDiscount * line.taxable / discountable) : 0);
    let remaining = invoiceDiscount - shares.reduce((sum, share) => sum + share, 0);
    const remainderOrder = values.map((line, index) => ({ index, remainder: discountable ? (invoiceDiscount * line.taxable) % discountable : 0 }))
      .sort((left, right) => right.remainder - left.remainder);
    for (const item of remainderOrder) {
      if (remaining <= 0) break;
      if (shares[item.index] < values[item.index].taxable) { shares[item.index] += 1; remaining -= 1; }
    }
    const tax = values.reduce((sum, line, index) => {
      const inclusiveAmount = line.taxable - shares[index];
      return sum + Math.round(inclusiveAmount * line.gstRate / (100 + line.gstRate));
    }, 0);
    const discount = productDiscount + invoiceDiscount;
    return { subtotal, discount, productDiscount, invoiceDiscount, tax, total: subtotal - discount };
  }, [lines, invoiceDiscountMode, invoiceDiscountInput]);
  const paymentPaisa = paisa(paymentAmount);
  const available = (productId: string) => entryData.retailBalances.find((row) => row.productId === productId && row.warehouseLocationId === locationId)?.available ?? 0;
  const lineTotal = (line: Line) => {
    const subtotal = Math.max(0, Number(line.quantity || 0) * paisa(line.unitPrice));
    return Math.max(0, subtotal - Math.min(subtotal, percentageDiscountPaisa(subtotal, line.discount)));
  };

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
        const discountPercent = Number(line.discount || 0);
        if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new Error("Product discount must be between 0% and 100%.");
        const unitPricePaisa = paisa(line.unitPrice);
        const lineSubtotalPaisa = quantity * unitPricePaisa;
        return { productId: product.id, productName: product.name, sku: product.sku, quantity, unitPricePaisa, gstRateBps: Number(line.gstRate) * 100, discountPaisa: percentageDiscountPaisa(lineSubtotalPaisa, line.discount) };
      });
      if (new Set(preparedLines.map(line => line.productId)).size !== preparedLines.length) throw new Error("Use one line per product; combine quantities on the same line.");
      const response = await fetch("/api/offline-sales", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ saleDate: date, requestedDispatchDate: requestedDispatchDate || undefined, billingInvoiceNumber: invoiceNo, invoiceFileName: invoiceFile.name, customerName: customer, customerCompanyName: companyName || undefined, customerContact: contact || undefined, billingAddress: billing, shippingSameAsBilling: sameAddress, shippingAddress: sameAddress ? billing : shipping, gstNumber: gstin || undefined, customerType: "retail", isNewB2bCustomer: false, warehouseLocationId: locationId, initialCollectionPaisa: paymentPaisa, additionalDiscountPaisa: totals.invoiceDiscount, paymentMode: paymentPaisa ? paymentMode : undefined, paymentTransactionId: transactionId || undefined, paymentReceiverName: receiver || undefined, paymentProofFileName: proof?.name, expectedNextPaymentDate: nextPaymentDate || undefined, lines: preparedLines }) });
      const result = await response.json() as { result?: { sale?: OfflineSaleRow }; error?: { message?: string } };
      if (!response.ok || !result.result?.sale) throw new Error(result.error?.message ?? "Order could not be saved.");
      const sale = result.result.sale;
      const uploadIssues: string[] = [];
      try { await upload(sale.id, "invoice", invoiceFile); } catch (e) { uploadIssues.push(e instanceof Error ? e.message : "Invoice upload failed."); }
      if (paymentPaisa > 0 && proof) try { await upload(sale.id, "payment_proof", proof); } catch (e) { uploadIssues.push(e instanceof Error ? e.message : "Payment proof upload failed."); }
      setNotice(`Order has been placed to warehouse · ${sale.billingInvoiceNumber}. Total ${money(sale.totalAmountPaisa)} · ${sale.paymentStatus} payment.${uploadIssues.length ? ` ${uploadIssues.join(" ")}` : " Invoice and payment documents uploaded."}`);
      setActiveTab("orders");
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Order could not be submitted."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    <section className="rounded-2xl bg-[#174f40] p-6 text-white"><p className="text-xs font-semibold uppercase tracking-[.16em] text-emerald-200">Retail sales</p><h1 className="mt-2 text-3xl font-bold">{activeTab === "create" ? "Create a customer order" : "My submitted orders"}</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-50">{activeTab === "create" ? "Orders are sent directly to the warehouse queue. Retail stock is reserved when the order is submitted and issued when Warehouse marks it dispatched." : "View orders submitted by your sales login and check warehouse fulfillment and payment status."}</p></section>
    {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p> : null}
    {notice ? <div role="status" aria-live="polite" className="fixed right-5 top-24 z-[120] flex max-w-xl items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm font-semibold text-emerald-950 shadow-xl"><span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white">✓</span><span>{notice}</span><button type="button" onClick={()=>setNotice("")} className="ml-2 text-lg leading-5 text-emerald-800" aria-label="Dismiss notification">×</button></div> : null}
    <div role="tablist" aria-label="Sales workspace" className="flex gap-2 rounded-xl border border-slate-200 bg-slate-50 p-1.5">
      <button type="button" role="tab" aria-selected={activeTab === "create"} onClick={()=>setActiveTab("create")} className={`flex-1 rounded-lg px-4 py-3 text-sm font-semibold ${activeTab === "create" ? "bg-white text-emerald-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white/70"}`}>Raise order</button>
      <button type="button" role="tab" aria-selected={activeTab === "orders"} onClick={()=>setActiveTab("orders")} className={`flex-1 rounded-lg px-4 py-3 text-sm font-semibold ${activeTab === "orders" ? "bg-white text-emerald-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white/70"}`}>Orders <span className="ml-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">{overview.submittedOrders?.length ?? 0}</span></button>
    </div>
    {activeTab === "create" ? <>
    <SalesProductForm/>
    <form onSubmit={submit} className="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <section><h2 className="text-lg font-bold text-slate-900">Invoice and customer</h2><div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-64 flex-1 text-sm font-semibold">Use saved customer<select className={input} value={selectedCustomerId} onChange={e=>selectCustomer(e.target.value)}><option value="">New / enter customer details</option>{customers.map(item=><option key={item.id} value={item.id}>{item.companyName ? `${item.companyName} · ${item.name}` : item.name} · {item.phone}</option>)}</select></label><button type="button" onClick={()=>{setCustomerError("");setShowCustomerForm(true);}} className="h-11 rounded-lg border border-blue-300 bg-white px-4 text-sm font-bold text-blue-800">+ Create customer</button></div><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm font-semibold">Order date<input className={input} type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label>
        <label className="text-sm font-semibold">Requested dispatch by <span className="font-normal text-slate-500">optional</span><input className={input} type="date" min={date} value={requestedDispatchDate} onChange={e=>setRequestedDispatchDate(e.target.value)}/></label>
        <label className="text-sm font-semibold">Biiing invoice number<input className={input} value={invoiceNo} onChange={e=>setInvoiceNo(e.target.value)} required minLength={2} maxLength={100}/></label>
        <label className="text-sm font-semibold">Invoice to / customer name<input className={input} value={customer} onChange={e=>setCustomer(e.target.value)} required minLength={2}/></label>
        <label className="text-sm font-semibold">Company name <span className="font-normal text-slate-500">optional</span><input className={input} value={companyName} onChange={e=>setCompanyName(e.target.value)}/></label>
        <label className="text-sm font-semibold">Phone / contact<input className={input} value={contact} onChange={e=>setContact(e.target.value)} placeholder="Customer contact"/></label>
        <label className="text-sm font-semibold sm:col-span-2">Billing address<textarea className="mt-1.5 min-h-24 w-full rounded-lg border border-slate-300 p-3 text-sm" value={billing} onChange={e=>setBilling(e.target.value)} required minLength={5}/></label>
        <label className="text-sm font-semibold">GSTIN <span className="font-normal text-slate-500">optional</span><input className={input} value={gstin} onChange={e=>setGstin(e.target.value.toUpperCase())} maxLength={15} placeholder="15 character GSTIN"/></label>
        <label className="text-sm font-semibold">Preparing warehouse<select className={input} value={locationId} onChange={e=>setLocationId(e.target.value)} required>{entryData.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      </div><label className="mt-4 flex items-center gap-2 text-sm font-medium text-slate-700"><input type="checkbox" checked={sameAddress} onChange={e=>setSameAddress(e.target.checked)} className="size-4 accent-emerald-700"/>Shipping address is same as billing</label>{!sameAddress?<label className="mt-3 block text-sm font-semibold">Shipping address<textarea className="mt-1.5 min-h-24 w-full rounded-lg border border-slate-300 p-3 text-sm" value={shipping} onChange={e=>setShipping(e.target.value)} required minLength={5}/></label>:null}</section>
      <section className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold text-slate-900">Products</h2><p className="mt-1 text-xs text-slate-500">Unit price auto-fills from your provided price list. All products are listed; orders require available Retail stock at the selected warehouse.</p>{entryData.products.every(product=>available(product.id)===0)?<p className="mt-2 text-xs font-medium text-amber-700">No products are currently in stock at this warehouse.</p>:null}</div><button type="button" onClick={()=>setLines(current=>[...current,freshLine()])} className="rounded-lg border border-blue-300 bg-white px-4 py-2 text-sm font-bold text-blue-800">+ Add product</button></div>
        <div className="mt-4 space-y-3">{lines.map((line,index)=><div key={index} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 xl:grid-cols-[minmax(190px,2fr)_75px_115px_90px_105px_125px_125px_auto] xl:items-end">
          <label className="text-xs font-semibold text-slate-600">Product<select className={input} value={line.productId} onChange={e=>updateLine(index,"productId",e.target.value)} required><option value="">Select product</option>{entryData.products.map(p=><option key={p.id} value={p.id}>{p.name} · {p.sku}{available(p.id)===0?" · No Retail stock":""}</option>)}</select></label>
          <label className="text-xs font-semibold text-slate-600">Qty<input className={input} type="number" min="1" step="1" value={line.quantity} onChange={e=>updateLine(index,"quantity",e.target.value)} required/></label>
          <label className="text-xs font-semibold text-slate-600">Unit price ₹<input className={input} type="number" min="0.01" step="0.01" value={line.unitPrice} onChange={e=>updateLine(index,"unitPrice",e.target.value)} required/></label>
          <label className="text-xs font-semibold text-slate-600">GST<select className={input} value={line.gstRate} onChange={e=>updateLine(index,"gstRate",e.target.value)}>{[0,5,12,18,28].map(x=><option key={x} value={x}>{x}%</option>)}</select></label>
          <label className="text-xs font-semibold text-slate-600">Discount %<input className={input} type="number" min="0" max="100" step="0.01" value={line.discount} onChange={e=>updateLine(index,"discount",e.target.value)}/></label>
          <div className="pb-2 text-xs text-slate-500">{line.productId?`${available(line.productId)} available`:"Stock —"}</div>
          <div className="pb-2 text-xs font-semibold text-slate-700">Total after discount<br/><span className="text-sm">{money(lineTotal(line))}</span></div>
          <button type="button" disabled={lines.length===1} onClick={()=>setLines(current=>current.filter((_,i)=>i!==index))} className="h-11 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-600 disabled:opacity-40">Remove</button>
        </div>)}</div>
      </section>
      <section className="grid gap-5 lg:grid-cols-[1fr_320px]"><div className="rounded-xl border border-slate-200 p-4"><h2 className="font-bold text-slate-900">Invoice copy</h2><p className="mt-1 text-xs text-slate-500">PDF, JPG, PNG, or WebP; up to 3 MB.</p><input ref={invoiceInputRef} id="invoice-copy-file" className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e=>setInvoiceFile(e.target.files?.[0]??null)}/><div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" aria-controls="invoice-copy-file" onClick={()=>invoiceInputRef.current?.click()} className="rounded-lg border border-emerald-700 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-900 hover:bg-emerald-100">+ Add invoice file</button>{invoiceFile?<div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700"><span className="max-w-64 truncate">{invoiceFile.name}</span><button type="button" onClick={()=>{setInvoiceFile(null);if(invoiceInputRef.current)invoiceInputRef.current.value="";}} className="font-bold text-rose-700" aria-label="Remove invoice file">Remove</button></div>:<span className="text-sm text-slate-500">No invoice file added</span>}</div></div><div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"><div className="mb-4 rounded-lg border border-slate-200 bg-white p-3"><label className="text-xs font-semibold text-slate-600">Extra invoice discount</label><div className="mt-2 grid grid-cols-[90px_1fr] overflow-hidden rounded-lg border border-slate-300"><select aria-label="Extra discount type" className="h-10 border-r border-slate-300 bg-slate-50 px-2 text-sm" value={invoiceDiscountMode} onChange={e=>setInvoiceDiscountMode(e.target.value as "percent"|"amount")}><option value="percent">%</option><option value="amount">₹</option></select><input aria-label="Extra invoice discount" className="h-10 min-w-0 px-3 text-sm outline-none" type="number" min="0" max={invoiceDiscountMode==="percent"?"100":undefined} step={invoiceDiscountMode==="percent"?"0.01":"0.01"} value={invoiceDiscountInput} onChange={e=>setInvoiceDiscountInput(e.target.value)}/></div></div><p className="flex justify-between"><span>Subtotal</span><b>{money(totals.subtotal)}</b></p><p className="mt-2 flex justify-between"><span>Product discounts</span><b>−{money(totals.productDiscount)}</b></p><p className="mt-2 flex justify-between"><span>Extra invoice discount</span><b>−{money(totals.invoiceDiscount)}</b></p><p className="mt-2 flex justify-between"><span>GST</span><b>{money(totals.tax)}</b></p><p className="mt-3 flex justify-between border-t pt-3 text-base"><span>Final amount</span><b>{money(totals.total)}</b></p></div></section>
      <section className="rounded-xl border border-slate-200 p-4"><h2 className="font-bold text-slate-900">Payment</h2><p className="mt-1 text-xs text-slate-500">Leave amount received as zero if payment is pending. Partial collections need an expected next payment date.</p><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><label className="text-sm font-semibold">Amount received now ₹<input className={input} type="number" min="0" step="0.01" value={paymentAmount} onChange={e=>setPaymentAmount(e.target.value)}/></label>{paymentPaisa>0?<><label className="text-sm font-semibold">Mode<select className={input} value={paymentMode} onChange={e=>setPaymentMode(e.target.value)}><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="cheque">Cheque</option><option value="other">Other</option></select></label><label className="text-sm font-semibold">Transaction ID {paymentMode==="cash"?"(optional)":""}<input className={input} value={transactionId} onChange={e=>setTransactionId(e.target.value)} required={paymentMode!=="cash"}/></label><label className="text-sm font-semibold">Received by<input className={input} value={receiver} onChange={e=>setReceiver(e.target.value)} required/></label><div className="text-sm font-semibold"><span>Payment proof</span><p className="mt-1 text-xs font-normal text-slate-500">PDF, JPG, PNG, or WebP; up to 3 MB.</p><input ref={proofInputRef} id="payment-proof-file" className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e=>setProof(e.target.files?.[0]??null)}/><div className="mt-2 flex flex-wrap items-center gap-3"><button type="button" aria-controls="payment-proof-file" onClick={()=>proofInputRef.current?.click()} className="rounded-lg border border-emerald-700 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-900 hover:bg-emerald-100">+ Add payment proof file</button>{proof?<div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm font-normal text-slate-700"><span className="max-w-56 truncate">{proof.name}</span><button type="button" onClick={()=>{setProof(null);if(proofInputRef.current)proofInputRef.current.value="";}} className="font-bold text-rose-700" aria-label="Remove payment proof file">Remove</button></div>:<span className="text-xs font-normal text-slate-500">No proof file added</span>}</div></div>{paymentPaisa<totals.total?<label className="text-sm font-semibold">Next payment expected<input className={input} type="date" value={nextPaymentDate} onChange={e=>setNextPaymentDate(e.target.value)} required/></label>:null}</>:null}</div><p className="mt-3 text-sm font-semibold text-slate-700">Status: {paymentPaisa<=0?"Pending":paymentPaisa>=totals.total?"Paid":"Partially paid"} · Remaining {money(Math.max(0,totals.total-paymentPaisa))}</p></section>
      <div className="flex justify-end"><button type="submit" disabled={busy||!entryData.locations.length||!entryData.products.length} className="h-12 rounded-xl bg-[#174f40] px-6 text-sm font-bold text-white disabled:opacity-50">{busy?"Submitting order…":"Submit order to warehouse →"}</button></div>
    </form>
    {showCustomerForm ? <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-3 sm:p-6" role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="add-customer-title" className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-[#f8f8f9] shadow-2xl"><header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4 sm:px-8"><div className="flex items-center gap-4"><button type="button" onClick={()=>setShowCustomerForm(false)} aria-label="Close add customer" className="text-3xl leading-none text-slate-400 hover:text-slate-700">×</button><h2 id="add-customer-title" className="text-xl font-bold text-slate-950 sm:text-2xl">Add Customer</h2></div><button type="button" onClick={()=>void createCustomer()} disabled={savingCustomer} className="h-11 rounded-xl bg-blue-600 px-5 text-sm font-bold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">{savingCustomer ? "Saving…" : "Save →"}</button></header><div className="overflow-y-auto px-5 py-6 sm:px-8"><div className="border-b border-slate-200"><p className="inline-block border-b-4 border-blue-600 px-2 pb-3 text-base font-semibold text-slate-900">Basic Details</p></div><section className="mt-5"><div className="mb-3 flex items-center justify-between px-1"><h3 className="text-base font-semibold text-slate-500">Basic Details</h3></div><div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 sm:p-7"><label className="block text-sm font-semibold text-slate-600"><span className="text-rose-600">*</span> Name<input autoFocus className={`${input} h-12`} value={newCustomerName} onChange={e=>setNewCustomerName(e.target.value)} placeholder="Customer name"/></label><div className="grid gap-5 md:grid-cols-2"><label className="block text-sm font-semibold text-slate-600">Phone<div className="mt-1.5 flex gap-2"><span className="flex h-11 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm">+91</span><input className={`${input} mt-0`} type="tel" value={newCustomerPhone} onChange={e=>setNewCustomerPhone(e.target.value)} placeholder="Phone number"/></div></label><div className="text-sm font-semibold text-slate-600">Address<textarea className="mt-1.5 min-h-24 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" value={newCustomerAddress} onChange={e=>setNewCustomerAddress(e.target.value)} placeholder="Billing address"/></div></div></div></section><section className="mt-6"><h3 className="mb-3 px-1 text-base font-semibold text-slate-500">Company Details <span className="font-normal">(Optional)</span></h3><div className="grid gap-5 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2 sm:p-7"><label className="text-sm font-semibold text-slate-600">GSTIN<input className={input} value={newCustomerGst} onChange={e=>setNewCustomerGst(e.target.value.toUpperCase())} maxLength={15} placeholder="15 character GSTIN"/></label><label className="text-sm font-semibold text-slate-600">Company Name<input className={input} value={newCustomerCompany} onChange={e=>setNewCustomerCompany(e.target.value)} placeholder="Company name"/></label></div></section></div><footer className="flex justify-end gap-3 border-t border-slate-200 bg-white px-5 py-4 sm:px-8"><button type="button" onClick={()=>setShowCustomerForm(false)} className="h-11 rounded-xl border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-700">Cancel</button><button type="button" onClick={()=>void createCustomer()} disabled={savingCustomer} className="h-11 rounded-xl bg-blue-600 px-5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50">{savingCustomer ? "Saving…" : "Save →"}</button></footer></section></div> : null}
    {showCustomerForm ? <p role="status" className="fixed bottom-5 left-1/2 z-[100] -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-xl">Required to save: customer name, phone number, and complete address. Company name and GSTIN are optional.</p> : null}
    {customerError ? <p role="alert" className="fixed left-1/2 top-24 z-[110] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900 shadow-xl">{customerError}</p> : null}
    </> : <section role="tabpanel" className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold text-slate-900">Orders submitted by you</h2><p className="mt-1 text-sm text-slate-500">{overview.submittedOrders?.length ?? 0} total orders · {money(overview.submittedOrders?.reduce((sum, sale) => sum + sale.pendingAmountPaisa, 0) ?? 0)} balance due</p></div><button type="button" onClick={()=>router.refresh()} className="h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Refresh orders</button></div>
      {overview.submittedOrders?.length ? <div className="divide-y divide-slate-100">{overview.submittedOrders.map((sale)=><article key={sale.id} className="py-4 first:pt-1 last:pb-1"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-slate-900">{sale.billingInvoiceNumber || sale.saleNumber} · {sale.customerName}</h3>{sale.customerCompanyName ? <p className="mt-1 text-sm text-slate-600">{sale.customerCompanyName}</p> : null}<p className="mt-1 text-xs text-slate-500">{new Date(sale.saleDate).toLocaleDateString("en-IN",{dateStyle:"medium",timeZone:"Asia/Kolkata"})}{sale.shippingAddress ? ` · ${sale.shippingAddress}` : ""}</p></div><div className="flex flex-wrap gap-2"><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold capitalize text-blue-800">{sale.deliveryStatus.replaceAll("_"," ")}</span><span className={`rounded-full px-3 py-1 text-xs font-semibold ${sale.paymentStatus === "paid" ? "bg-emerald-100 text-emerald-800" : sale.paymentStatus === "partial" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}>{sale.paymentStatus === "paid" ? "Paid" : sale.paymentStatus === "partial" ? "Partially paid" : "Pending payment"}</span></div></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{sale.lines.map((line,index)=><p key={`${sale.id}-${index}`} className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{line.productName} × {line.quantity}</p>)}</div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-bold text-slate-900">Total {money(sale.totalAmountPaisa)}</span><span className="text-slate-600">Paid {money(sale.collectedAmountPaisa)} · Balance {money(sale.pendingAmountPaisa)}</span></div>
        {sale.requestedDispatchDate ? <p className="mt-2 text-xs font-semibold text-amber-700">Requested dispatch by {new Date(`${sale.requestedDispatchDate}T12:00:00+05:30`).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"})}</p> : null}
        {sale.deliveredAt ? <p className="mt-1 text-xs font-semibold text-emerald-800">Delivered on {new Date(sale.deliveredAt).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Kolkata"})}</p> : null}
      </article>)}</div> : <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center"><p className="font-semibold text-slate-800">No submitted orders yet</p><p className="mt-1 text-sm text-slate-500">Orders you raise will appear here.</p><button type="button" onClick={()=>setActiveTab("create")} className="mt-4 rounded-lg bg-[#174f40] px-4 py-2 text-sm font-semibold text-white">Raise an order</button></div>}
    </section>}
  </div>;
}
