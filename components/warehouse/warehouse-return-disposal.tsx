"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { BUCKET_LABELS, bucketAvailable } from "@/lib/inventory/stock-condition";
import type { DashboardRole } from "@/types/auth";
import type { WarehouseBucketBalance, WarehouseInventoryBucket, WarehouseLocationOption, WarehouseProductOption, WarehouseWorkspaceData } from "@/types/warehouse";

type EntryKind = "return" | "disposal";
type ReturnCondition = "usable" | "damaged" | "missing" | "expired";
type DisposalReason = "expired" | "damaged" | "contaminated" | "quality_rejected" | "other";
interface Line { id: string; productId: string; quantity: string; condition: ReturnCondition; remarks: string; }

const inputClass = "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";

export function WarehouseReturnDisposal({ kind, products, locations, balances, expiries, userRole, onManageStock }: {
  kind: EntryKind;
  products: WarehouseProductOption[];
  locations: WarehouseLocationOption[];
  balances: WarehouseBucketBalance[];
  expiries: WarehouseWorkspaceData["expiries"];
  userRole: DashboardRole;
  onManageStock?: () => void;
}) {
  const router = useRouter();
  const [orderType, setOrderType] = useState<"shopify" | "retail">("shopify");
  const [orderId, setOrderId] = useState("");
  const [courier, setCourier] = useState("");
  const [rtoCost, setRtoCost] = useState("");
  const [manifestedDate, setManifestedDate] = useState("");
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().slice(0, 10));
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [lines, setLines] = useState<Line[]>([{ id: crypto.randomUUID(), productId: products[0]?.id ?? "", quantity: "", condition: "usable", remarks: "" }]);
  const [category, setCategory] = useState<WarehouseProductOption["category"] | "">(products[0]?.category ?? "");
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [sourceBucket, setSourceBucket] = useState<WarehouseInventoryBucket>("damaged");
  const [disposalQuantity, setDisposalQuantity] = useState("");
  const [disposalReason, setDisposalReason] = useState<DisposalReason>("damaged");
  const [expiryDate, setExpiryDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [approvalProof, setApprovalProof] = useState<File | null>(null);
  const [stage, setStage] = useState<"edit" | "review" | "success">("edit");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedProduct = products.find((product) => product.id === productId) ?? null;
  const categoryProducts = products.filter((product) => product.category === category);
  const matchingProducts = categoryProducts.length ? categoryProducts : products;
  const available = (id: string, bucket: WarehouseInventoryBucket) => bucketAvailable(balances, id, locationId, bucket);
  const matchingExpiry = useMemo(() => expiries.filter((batch) => batch.productId === productId && batch.warehouseLocationId === locationId).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate)), [expiries, productId, locationId]);
  const saleableQty = lines.reduce((sum, line) => sum + (Number.isSafeInteger(Number(line.quantity)) && Number(line.quantity) > 0 ? Number(line.quantity) : 0), 0);

  function updateLine(id: string, key: keyof Omit<Line, "id">, value: string) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, [key]: value } : line));
    setError(null);
  }

  function review(event: FormEvent) {
    event.preventDefault();
    if (!locationId) return setError("Select a warehouse location.");
    if (kind === "return") {
      if (!orderId.trim() || !courier.trim() || !receivedDate || !manifestedDate || !rtoCost.trim()) return setError("Complete the order ID, courier, RTO cost, and both RTO dates.");
      const cost = Math.round(Number(rtoCost) * 100);
      if (!Number.isSafeInteger(cost) || cost < 0) return setError("Enter a valid RTO cost (enter 0 if there is no cost).");
      if (!lines.length || lines.some((line) => !line.productId || !Number.isSafeInteger(Number(line.quantity)) || Number(line.quantity) <= 0 || !line.condition || !line.remarks.trim())) return setError("Complete every returned product row, including quantity, status, and remarks.");
      if (manifestedDate && manifestedDate > receivedDate) return setError("Manifested date cannot be after the received date.");
    } else {
      if (!category || !productId || !disposalQuantity || !remarks.trim() || !expiryDate) return setError("Complete product category, product, quantity, expiry, and reason / remark.");
      if (userRole !== "admin" && !approvalProof) return setError("Upload your manager's approval proof before continuing.");
      const count = Number(disposalQuantity);
      if (!Number.isSafeInteger(count) || count <= 0) return setError("Enter a positive whole quantity.");
      const availableQuantity = available(productId, sourceBucket) ?? 0;
      if (count > availableQuantity) return setError(`Only ${availableQuantity} packets are available in ${BUCKET_LABELS[sourceBucket]}.`);
      if (sourceBucket === "online" && !selectedProduct?.shopifyMappingId) return setError("This product needs a verified Shopify mapping before Online stock can be disposed.");
      if (disposalReason === "expired" && !expiryDate) return setError("Select the expired batch date.");
    }
    setError(null);
    setStage("review");
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const key = crypto.randomUUID();
      if (kind === "return") {
        for (const line of lines) {
          const response = await fetch("/api/warehouse/returns", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `${key}:${line.id}` }, body: JSON.stringify({ productId: line.productId, warehouseLocationId: locationId, quantity: Number(line.quantity), orderType, channel: orderType, referenceId: orderId.trim(), courier: courier.trim(), rtoCostPaisa: Math.round(Number(rtoCost) * 100), manifestedAt: manifestedDate || undefined, receivedAt: receivedDate, condition: line.condition, reason: line.condition, notes: line.remarks.trim() || undefined }) });
          const body = await response.json() as { error?: { message?: string } };
          if (!response.ok) throw new Error(body.error?.message ?? "Return could not be recorded.");
        }
        setSuccess(`Return ${orderId.trim()} recorded. Usable items are in QC for inspection; damaged and expired items are in Damaged; missing items do not increase stock.`);
      } else {
        const form = new FormData();
        form.set("payload", JSON.stringify({ productId, warehouseLocationId: locationId, sourceBucket, quantity: Number(disposalQuantity), disposalReason, expiryDate, referenceId: `DISP-${new Date().toISOString().slice(0, 10)}-${key.slice(0, 8)}`, notes: `${remarks.trim()}${expiryDate ? ` · Expiry ${expiryDate}` : ""}`, shopifyMappingId: sourceBucket === "online" ? selectedProduct?.shopifyMappingId : undefined }));
        if (approvalProof) form.set("approvalProof", approvalProof);
        const response = await fetch("/api/warehouse/disposals", { method: "POST", headers: { "Idempotency-Key": key }, body: form });
        const body = await response.json() as { result?: { shopifySync?: string }; error?: { message?: string } };
        if (!response.ok || !body.result) throw new Error(body.error?.message ?? "Disposal could not be recorded.");
        setSuccess(`Disposal recorded. ${sourceBucket === "online" ? `Shopify inventory sync: ${body.result.shopifySync ?? "pending"}.` : "Stock was reduced in the selected warehouse bucket."}`);
      }
      setStage("success");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The entry could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  function startAgain() {
    setOrderId(""); setCourier(""); setRtoCost(""); setManifestedDate(""); setReceivedDate(new Date().toISOString().slice(0, 10));
    setLines([{ id: crypto.randomUUID(), productId: products[0]?.id ?? "", quantity: "", condition: "usable", remarks: "" }]);
    setDisposalQuantity(""); setRemarks(""); setApprovalProof(null); setSuccess(null); setStage("edit"); setError(null);
  }

  const title = kind === "return" ? "Return on order" : "Stock disposal";
  return <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
    <header className="border-b border-slate-100 px-5 py-5 sm:px-7"><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">{stage === "edit" ? "Step 1 of 2 · Enter" : stage === "review" ? "Step 2 of 2 · Review" : "Completed"}</p><h2 className="mt-1 text-xl font-bold text-slate-950">{stage === "success" ? `${title} saved` : title}</h2><p className="mt-1 text-sm text-slate-500">{kind === "return" ? "Record RTO and customer returns. Stock status is updated in the warehouse ledger." : "Record damaged, expired, or otherwise unusable stock removed from inventory."}</p></header>
    <div className="space-y-6 p-5 sm:p-7">
      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">{error}</div> : null}
      {stage === "success" ? <div className="space-y-5"><div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">{success}</div><button type="button" onClick={startAgain} className="h-11 rounded-xl bg-brand-primary px-5 text-sm font-bold text-white">Record another {kind === "return" ? "return" : "disposal"}</button></div> : null}
      {stage === "edit" && kind === "return" ? <form className="space-y-6" onSubmit={review}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Order ID"><input className={inputClass} value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="Shopify order / retail invoice" required/></Field>
          <Field label="Order type"><select className={inputClass} value={orderType} onChange={(e) => setOrderType(e.target.value as "shopify" | "retail")}><option value="shopify">D2C / Shopify</option><option value="retail">Retail</option></select></Field>
          <Field label="Courier"><input className={inputClass} value={courier} onChange={(e) => setCourier(e.target.value)} required/></Field>
          <Field label="RTO cost (₹)"><input className={inputClass} type="number" min="0" step="0.01" value={rtoCost} onChange={(e) => setRtoCost(e.target.value)} placeholder="0.00" required/></Field>
          <Field label="RTO manifested date"><input className={inputClass} type="date" value={manifestedDate} onChange={(e) => setManifestedDate(e.target.value)} required/></Field>
          <Field label="RTO received date"><input className={inputClass} type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} required/></Field>
          <Field label="Warehouse location"><select className={inputClass} value={locationId} onChange={(e) => setLocationId(e.target.value)} required>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        </div>
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5"><div className="flex items-center justify-between"><div><h3 className="font-bold text-slate-900">Returned products</h3><p className="mt-1 text-xs text-slate-500">Usable stock goes to QC until it passes inspection.</p></div><button type="button" onClick={() => setLines((items) => [...items, { id: crypto.randomUUID(), productId: "", quantity: "", condition: "usable", remarks: "" }])} className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm font-bold text-emerald-800">+ Add product</button></div>
          {lines.map((line, index) => <div key={line.id} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 xl:grid-cols-[2fr_0.7fr_1fr_1.5fr_auto]"><Field label={`Product ${index + 1}`}><select className={inputClass} value={line.productId} onChange={(e) => updateLine(line.id, "productId", e.target.value)} required><option value="">Choose product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></Field><Field label="Qty"><input className={inputClass} type="number" min="1" step="1" value={line.quantity} onChange={(e) => updateLine(line.id, "quantity", e.target.value)} required/></Field><Field label="Status"><select className={inputClass} value={line.condition} onChange={(e) => updateLine(line.id, "condition", e.target.value as ReturnCondition)}><option value="usable">Usable</option><option value="damaged">Damaged</option><option value="missing">Missing</option><option value="expired">Expired</option></select></Field><Field label="Remarks"><input className={inputClass} value={line.remarks} onChange={(e) => updateLine(line.id, "remarks", e.target.value)} required/></Field><button type="button" className="h-11 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-600 disabled:opacity-40" disabled={lines.length === 1} onClick={() => setLines((items) => items.filter((item) => item.id !== line.id))}>Remove</button></div>)}
        </div>
        <p className="text-xs leading-5 text-slate-500">This records the return and inventory condition. Shopify refund/order financial changes and retail sales reversals must follow the selected Accounts process.</p>
        <div className="flex justify-end"><button type="submit" className="h-11 rounded-xl bg-brand-primary px-6 text-sm font-bold text-white">Review return →</button></div>
      </form> : null}
      {stage === "edit" && kind === "disposal" ? <form className="space-y-5" onSubmit={review}>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p>Disposal deducts from the selected bucket. If damaged packets are still recorded as Buffer, Retail, or Online, move them to Damaged first.</p>{onManageStock ? <button type="button" onClick={onManageStock} className="mt-2 font-bold underline">Manage Damaged &amp; QC / Hold stock →</button> : null}</div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Field label="Product category"><select className={inputClass} value={category} onChange={(e) => { const next = e.target.value as WarehouseProductOption["category"]; setCategory(next); const nextProducts = products.filter((product) => product.category === next); setProductId((nextProducts.length ? nextProducts : products)[0]?.id ?? ""); setExpiryDate(""); }} required><option value="">Select category</option><option value="noodles">Noodles</option><option value="cookies">Cookies</option><option value="rte">RTE</option><option value="other">Other</option></select></Field><Field label="Product name" hint={!categoryProducts.length && category ? "No products are tagged in this category; showing all products." : undefined}><select className={inputClass} value={productId} onChange={(e) => { setProductId(e.target.value); const next = products.find((product) => product.id === e.target.value); if (next) setCategory(next.category); setExpiryDate(""); }} required><option value="">Select product</option>{matchingProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></Field><Field label="Warehouse location"><select className={inputClass} value={locationId} onChange={(e) => { setLocationId(e.target.value); setExpiryDate(""); }} required>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Stock bucket" hint={`${available(productId, sourceBucket)} packets available in ${BUCKET_LABELS[sourceBucket]} at this warehouse.`}><select className={inputClass} value={sourceBucket} onChange={(e) => setSourceBucket(e.target.value as WarehouseInventoryBucket)}><option value="damaged">Damaged</option><option value="qc">QC / Hold</option><option value="buffer">Buffer</option><option value="retail">Retail</option><option value="online">Shopify / Online</option></select></Field><Field label="Quantity"><input className={inputClass} type="number" min="1" step="1" max={productId ? available(productId, sourceBucket) : undefined} value={disposalQuantity} onChange={(e) => setDisposalQuantity(e.target.value)} required/></Field><Field label="Unit price (fixed)"><input className={inputClass} value={selectedProduct ? `₹${(selectedProduct.unitPricePaisa / 100).toFixed(2)}` : ""} readOnly/></Field><Field label="Stock value (auto)"><input className={inputClass} value={selectedProduct && disposalQuantity ? `₹${(selectedProduct.unitPricePaisa * Number(disposalQuantity) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : ""} readOnly/></Field><Field label="Reason"><select className={inputClass} value={disposalReason} onChange={(e) => setDisposalReason(e.target.value as DisposalReason)}><option value="damaged">Damaged</option><option value="expired">Expired</option><option value="contaminated">Contaminated</option><option value="quality_rejected">Quality rejected</option><option value="other">Other</option></select></Field><Field label="Expiry date" hint={matchingExpiry.length ? `Recorded batch dates: ${matchingExpiry.map((batch) => `${new Date(batch.expiryDate).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} (${batch.batchNumber})`).join(", ")}` : "Enter the expiry printed on the affected product."}><input className={inputClass} type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} required/></Field></div>
        <Field label="Reason / remark"><textarea className="min-h-24 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={500} required/></Field>
        <Field label="Manager approval proof" hint={userRole === "admin" ? "Optional for administrators. PDF or image, up to 3 MB." : "Required before warehouse staff can dispose stock. PDF or image, up to 3 MB."}><input className={inputClass} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required={userRole !== "admin"} onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && (file.size > 3 * 1024 * 1024 || !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type))) { setError("Choose a PDF, JPG, PNG, or WebP file up to 3 MB."); event.target.value = ""; setApprovalProof(null); return; } setApprovalProof(file); setError(null); }}/></Field>
        <div className="flex justify-end"><button type="submit" disabled={available(productId, sourceBucket) === 0} className="h-11 rounded-xl bg-brand-primary px-6 text-sm font-bold text-white disabled:opacity-50">Review disposal →</button></div>
      </form> : null}
      {stage === "review" ? <div className="space-y-5"><div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">Review the stock movement before recording it. Ledger quantities will update when you submit.</div><dl className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-4"><Summary label="Entry" value={title}/><Summary label={kind === "return" ? "Order" : "Product"} value={kind === "return" ? `${orderId} · ${orderType.toUpperCase()}` : selectedProduct?.name ?? ""}/><Summary label="Quantity" value={kind === "return" ? `${saleableQty} packets` : `${disposalQuantity} packets from ${sourceBucket}`}/><Summary label="Stock effect" value={kind === "return" ? "Usable → QC; damaged / expired → Damaged; missing → no balance change" : `${sourceBucket} reduced by ${disposalQuantity}`}/>{kind === "disposal" && selectedProduct ? <Summary label="Stock value removed" value={`₹${(selectedProduct.unitPricePaisa * Number(disposalQuantity) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`}/> : null}</dl><div className="grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setStage("edit")} disabled={busy} className="h-11 rounded-xl border border-slate-300 font-bold text-slate-700">← Edit</button><button type="button" onClick={submit} disabled={busy} className="h-11 rounded-xl bg-brand-primary font-bold text-white disabled:opacity-50">{busy ? "Saving…" : "Submit entry"}</button></div></div> : null}
    </div>
  </section>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-800">{label}</span>{children}{hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}</label>; }
function Summary({ label, value }: { label: string; value: ReactNode }) { return <div className="flex justify-between gap-4 py-3 text-sm"><dt className="text-slate-500">{label}</dt><dd className="text-right font-semibold text-slate-800">{value}</dd></div>; }
