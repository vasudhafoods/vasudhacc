"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BUCKET_LABELS, bucketAvailable, conditionDestinations } from "@/lib/inventory/stock-condition";
import type { WarehouseInventoryBucket, WarehouseWorkspaceData } from "@/types/warehouse";

const inputClass = "mt-1 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-100";
const buckets = Object.keys(BUCKET_LABELS) as WarehouseInventoryBucket[];

export function WarehouseStockCondition({ data, onDispose }: { data: WarehouseWorkspaceData; onDispose: () => void }) {
  const router = useRouter();
  const [productId, setProductId] = useState(data.products[0]?.id ?? "");
  const [locationId, setLocationId] = useState(data.locations[0]?.id ?? "");
  const [fromBucket, setFromBucket] = useState<WarehouseInventoryBucket>("buffer");
  const [toBucket, setToBucket] = useState<WarehouseInventoryBucket>("damaged");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const product = data.products.find(row => row.id === productId);
  const available = (bucket: WarehouseInventoryBucket) => bucketAvailable(data.balances, productId, locationId, bucket);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSuccess("");
    if (!product || !locationId) return setError("Select a product and warehouse.");
    if (!Number.isSafeInteger(Number(quantity)) || Number(quantity) <= 0 || Number(quantity) > available(fromBucket)) return setError(`Enter a positive whole quantity up to ${available(fromBucket)} available packets.`);
    if (!reason.trim()) return setError("Enter the reason for this stock movement.");
    if (fromBucket === "online" && !product.shopifyMappingId) return setError("Online stock needs a verified Shopify mapping before it can be moved.");
    setRequestKey(crypto.randomUUID()); setAttempted(false);
  }

  async function submit() {
    if (!requestKey || busy) return;
    setBusy(true); setAttempted(true); setError("");
    try {
      const response = await fetch("/api/warehouse/stock-condition", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey },
        body: JSON.stringify({ productId, warehouseLocationId: locationId, fromBucket, toBucket, quantity: Number(quantity), reason: reason.trim(), shopifyMappingId: fromBucket === "online" ? product?.shopifyMappingId : undefined }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status < 500) setAttempted(false);
        throw new Error(body.error?.message ?? "Stock movement could not be confirmed. Retry this entry.");
      }
      setSuccess(`${quantity} packets of ${product?.name} moved from ${BUCKET_LABELS[fromBucket]} to ${BUCKET_LABELS[toBucket]}. Shopify sync: ${body.result.shopifySync.replaceAll("_", " ")}.`);
      setRequestKey(null); setAttempted(false); setQuantity(""); setReason("");
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to confirm. Retry this entry without duplicating it."); }
    finally { setBusy(false); }
  }

  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
    <h2 className="text-xl font-bold text-slate-950">Damaged &amp; QC / Hold</h2>
    <p className="mt-1 text-sm text-slate-600">Move existing warehouse stock out of saleable inventory for damage or inspection. These buckets are excluded from sales allocation. Total physical quantity stays the same until disposal.</p>
    {error ? <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {success ? <p role="status" className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">{success}</p> : null}
    <form onSubmit={review} className="mt-5 space-y-5">
      <fieldset disabled={Boolean(requestKey) || busy} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold">Product<select className={inputClass} value={productId} onChange={event => setProductId(event.target.value)} required>{data.products.map(row => <option key={row.id} value={row.id}>{row.name} · {row.sku}</option>)}</select></label>
        <label className="text-sm font-semibold">Warehouse location<select className={inputClass} value={locationId} onChange={event => setLocationId(event.target.value)} required>{data.locations.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">{buckets.map(bucket => <div key={bucket} className={`rounded-xl border p-3 ${bucket === "damaged" ? "border-red-200 bg-red-50" : bucket === "qc" ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}><p className="text-sm font-semibold">{BUCKET_LABELS[bucket]}</p><p className="mt-1 text-2xl font-bold">{available(bucket)}</p><p className="text-xs text-slate-600">available packets</p></div>)}</div>
      {success ? <button type="button" onClick={onDispose} className="rounded-lg border border-emerald-700 px-4 py-2 text-sm font-semibold text-emerald-900">Open stock disposal →</button> : null}
      {!requestKey ? <>
        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold">Move from<select className={inputClass} value={fromBucket} onChange={event => { const source = event.target.value as WarehouseInventoryBucket; setFromBucket(source); setToBucket(conditionDestinations(source)[0]); }} required>{buckets.map(bucket => <option key={bucket} value={bucket}>{BUCKET_LABELS[bucket]} · {available(bucket)} available</option>)}</select></label>
          <label className="text-sm font-semibold">Move to<select className={inputClass} value={toBucket} onChange={event => setToBucket(event.target.value as WarehouseInventoryBucket)} required>{conditionDestinations(fromBucket).map(bucket => <option key={bucket} value={bucket}>{fromBucket === "qc" && bucket === "buffer" ? "Release inspected stock to Buffer" : BUCKET_LABELS[bucket]}</option>)}</select></label>
          <label className="text-sm font-semibold">Quantity<input className={inputClass} type="number" min="1" max={available(fromBucket)} step="1" required value={quantity} onChange={event => setQuantity(event.target.value)}/></label>
          <label className="text-sm font-semibold">Reason / inspection notes<input className={inputClass} required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}/></label>
        </fieldset>
        {available(fromBucket) === 0 ? <p className="text-sm text-amber-800">No available stock in {BUCKET_LABELS[fromBucket]} at this warehouse. Choose the bucket where the packets are currently recorded.</p> : null}
        <p className="text-xs text-slate-600">Reserved packets cannot be moved. Saleable stock follows the existing 40% Online / 40% Retail / 20% Buffer allocation after the movement. Damaged stock must go through QC before release.</p>
        <button type="submit" disabled={!product || !locationId || available(fromBucket) === 0 || busy} className="h-11 rounded-xl bg-brand-primary px-5 text-sm font-bold text-white disabled:opacity-50">Review movement →</button>
      </> : <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h3 className="font-bold">Review stock movement</h3>
        <p className="text-sm">{product?.name} · {data.locations.find(row => row.id === locationId)?.name}</p>
        <p className="font-semibold">{quantity} packets: {BUCKET_LABELS[fromBucket]} → {BUCKET_LABELS[toBucket]}</p>
        <p className="text-sm">Reason: {reason}</p>
        <p className="text-xs">This moves existing stock; it does not receive or dispose of any packets.</p>
        <div className="flex gap-3"><button type="button" disabled={busy || attempted} onClick={() => setRequestKey(null)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50">Edit</button><button type="button" disabled={busy} onClick={submit} className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? "Saving…" : attempted ? "Retry same movement" : "Confirm movement"}</button></div>
      </div>}
    </form>
  </section>;
}
