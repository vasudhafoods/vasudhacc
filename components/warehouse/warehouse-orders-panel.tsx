"use client";

import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import type { OfflineSaleRow } from "@/types/offline-sales";
import type { ShopifyWarehouseOrder } from "@/types/warehouse";

type Status = "packing" | "shipped" | "out_for_delivery" | "delivered";
type Slip = { fileName: string; url: string };
type TrackingProvider = "delhivery" | "manual";

const DELHIVERY_TRACKING_URL = "https://www.delhivery.com/tracking";

export function WarehouseOrdersPanel({ salesOrders, shopifyOrders, shopifyOrdersError, migrationPending, slips }: {
  salesOrders: OfflineSaleRow[];
  shopifyOrders: ShopifyWarehouseOrder[];
  shopifyOrdersError: string | null;
  migrationPending: boolean;
  slips: Record<string, Slip>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [carrier, setCarrier] = useState<Record<string, string>>({});
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [trackingUrl, setTrackingUrl] = useState<Record<string, string>>({});
  const [trackingProvider, setTrackingProvider] = useState<Record<string, TrackingProvider>>({});
  const [selectedSlip, setSelectedSlip] = useState<Record<string, File | null>>({});
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [savedStatuses, setSavedStatuses] = useState<Record<string, string>>({});
  const [notifyCustomer, setNotifyCustomer] = useState<Record<string, boolean>>({});

  async function updateRetail(order: OfflineSaleRow) {
    const currentStatus = savedStatuses[order.id] ?? order.deliveryStatus;
    const status = statuses[order.id] ?? (currentStatus === "packing" ? "shipped" : currentStatus === "shipped" ? "out_for_delivery" : "delivered");
    setBusy(order.id); setMessage("");
    try {
      const response = await fetch(`/api/warehouse/offline-sales/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, deliveryPartner: carrier[order.id] ?? order.deliveryPartner ?? "", trackingNumber: tracking[order.id] ?? order.lrNumber ?? "", trackingUrl: trackingUrl[order.id] ?? order.trackingUrl ?? "" }) });
      const body = await response.json() as { result?: { status?: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Retail order could not be updated.");
      setSavedStatuses((old) => ({ ...old, [order.id]: body.result?.status ?? status }));
      setStatuses((old) => { const next = { ...old }; delete next[order.id]; return next; });
      const slip = selectedSlip[order.id];
      if (slip) {
        const form = new FormData(); form.set("kind", "tracking_slip"); form.set("file", slip);
        const upload = await fetch(`/api/offline-sales/${order.id}/documents`, { method: "POST", body: form });
        const uploadBody = await upload.json() as { error?: { message?: string } };
        if (!upload.ok) throw new Error(`Order status was saved, but the tracking slip upload failed: ${uploadBody.error?.message ?? "Try uploading the file again."}`);
      }
      setMessage(`Order ${order.billingInvoiceNumber ?? order.saleNumber} updated to ${status.replaceAll("_", " ")}.`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Retail order could not be updated."); }
    finally { setBusy(""); }
  }

  async function fulfillShopify(order: ShopifyWarehouseOrder) {
    setBusy(order.id); setMessage("");
    try {
      const provider = trackingProvider[order.id] ?? "delhivery";
      const selectedTrackingUrl = provider === "delhivery" ? DELHIVERY_TRACKING_URL : trackingUrl[order.id];
      const selectedCarrier = carrier[order.id]?.trim() || (provider === "delhivery" ? "Delhivery" : "");
      const response = await fetch("/api/warehouse/shopify-orders/fulfill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id, trackingNumber: tracking[order.id], carrier: selectedCarrier, trackingUrl: selectedTrackingUrl || undefined, notifyCustomer: notifyCustomer[order.id] !== false }) });
      const body = await response.json() as { result?: { orderName: string }; error?: { message?: string } };
      if (!response.ok || !body.result) throw new Error(body.error?.message ?? "Shopify fulfillment could not be created.");
      setMessage(`${body.result.orderName} fulfilled in Shopify with tracking ${tracking[order.id]}.`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Shopify fulfillment could not be created."); }
    finally { setBusy(""); }
  }

  const inputClass = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";
  const fileChange = (orderId: string) => (event: ChangeEvent<HTMLInputElement>) => setSelectedSlip((current) => ({ ...current, [orderId]: event.target.files?.[0] ?? null }));

  return <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
    <header><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Warehouse desk</p><h2 className="mt-1 text-2xl font-bold text-slate-950">Orders</h2><p className="mt-1 text-sm text-slate-500">Shopify orders are fulfilled back to Shopify with tracking. Retail orders from Sales are updated here with delivery status and tracking documents.</p></header>
    {message ? <p role="status" aria-live="polite" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p> : null}
    {migrationPending ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Sales order database updates are pending. Run <code className="font-bold">npm run db:migrate</code> and refresh.</p> : null}

    <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-lg font-bold text-slate-900">Shopify orders</h3><p className="text-xs text-slate-500">Open orders with items waiting to be fulfilled.</p></div><span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-bold text-violet-800">{shopifyOrders.length} waiting</span></div>
      {shopifyOrdersError ? <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">Couldn’t load Shopify fulfillment orders: {shopifyOrdersError}. Confirm that the Shopify app has <code>read_orders</code>, <code>read_merchant_managed_fulfillment_orders</code>, and <code>write_merchant_managed_fulfillment_orders</code> scopes, then reinstall/approve its released version.</p> : shopifyOrders.length ? shopifyOrders.map((order) => <article key={order.id} className="rounded-xl border border-violet-100 bg-violet-50/40 p-4"><div className="flex flex-wrap justify-between gap-3"><div><h4 className="font-bold text-slate-900">{order.name} · {order.customerName}</h4><p className="mt-1 text-xs text-slate-500">{new Date(order.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })} · {order.destination || "No shipping address"}</p><p className="mt-1 text-sm font-semibold">{order.currency} {order.total}</p></div><span className="h-fit rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-900">Awaiting fulfillment</span></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{order.lines.map((line, index) => <p key={`${order.id}-${index}`} className="rounded-lg bg-white px-3 py-2 text-xs text-slate-700">{line.title}{line.sku ? ` · ${line.sku}` : ""} × {line.quantity}</p>)}</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><label className="text-xs font-semibold text-slate-600">Delivery partner<input className={inputClass} value={carrier[order.id] ?? ((trackingProvider[order.id] ?? "delhivery") === "delhivery" ? "Delhivery" : "")} onChange={(event) => setCarrier((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="Courier / carrier"/></label><label className="text-xs font-semibold text-slate-600">Tracking number<input className={inputClass} value={tracking[order.id] ?? ""} onChange={(event) => setTracking((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="AWB / tracking ID"/></label><label className="text-xs font-semibold text-slate-600">Tracking URL option<select className={inputClass} value={trackingProvider[order.id] ?? "delhivery"} onChange={(event) => { const provider = event.target.value as TrackingProvider; setTrackingProvider((old) => ({ ...old, [order.id]: provider })); if (provider === "manual") setTrackingUrl((old) => ({ ...old, [order.id]: "" })); }}><option value="delhivery">Delhivery</option><option value="manual">Manual</option></select></label><label className="text-xs font-semibold text-slate-600">Tracking URL<input className={inputClass} type="url" readOnly={(trackingProvider[order.id] ?? "delhivery") === "delhivery"} value={(trackingProvider[order.id] ?? "delhivery") === "delhivery" ? DELHIVERY_TRACKING_URL : trackingUrl[order.id] ?? ""} onChange={(event) => setTrackingUrl((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="https://… (optional)"/></label><div className="flex flex-col justify-end gap-2"><label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={notifyCustomer[order.id] !== false} onChange={(event) => setNotifyCustomer((old) => ({ ...old, [order.id]: event.target.checked }))}/> Notify customer through Shopify</label><button type="button" disabled={busy === order.id} onClick={() => void fulfillShopify(order)} className="h-10 rounded-lg bg-[#174f40] px-4 text-sm font-bold text-white disabled:opacity-50">{busy === order.id ? "Sending…" : "Fulfill in Shopify →"}</button></div></div>
      </article>) : <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No open Shopify orders are waiting for fulfillment.</p>}
    </section>

    <section className="space-y-3 border-t border-slate-100 pt-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-lg font-bold text-slate-900">Retail orders from Sales</h3><p className="text-xs text-slate-500">Stock is issued when an order is marked shipped.</p></div><span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-800">{salesOrders.filter((order) => !["delivered", "cancelled"].includes(order.deliveryStatus)).length} active · {salesOrders.length} total</span></div>
      {salesOrders.length ? salesOrders.map((order) => {
        const savedStatus = savedStatuses[order.id] ?? order.deliveryStatus;
        const status = statuses[order.id] ?? (savedStatus === "dispatched" ? "delivered" : savedStatus as Status);
        const terminal = ["delivered", "cancelled"].includes(savedStatus);
        const currentSlip = selectedSlip[order.id];
        const existingSlip = slips[order.id];
        return <article key={order.id} className="rounded-xl border border-violet-100 bg-violet-50/40 p-4"><div className="flex flex-wrap justify-between gap-3"><div><h4 className="font-bold text-slate-900">{order.billingInvoiceNumber ?? order.saleNumber} · {order.customerName}</h4><p className="mt-1 text-xs text-slate-500">{new Date(order.saleDate).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })} · {order.shippingAddress || "No shipping address"}</p><p className="mt-1 text-sm font-semibold">₹{(order.totalAmountPaisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</p></div><div className="flex h-fit flex-wrap items-center gap-2"><span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold capitalize text-violet-900">{savedStatus.replaceAll("_", " ")}</span>{order.requestedDispatchDate ? <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">Dispatch by {new Date(`${order.requestedDispatchDate}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}</span> : null}</div></div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">{order.lines.map((line, index) => <p key={`${order.id}-${index}`} className="rounded-lg bg-white px-3 py-2 text-xs text-slate-700">{line.productName} × {line.quantity}</p>)}</div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><label className="text-xs font-semibold text-slate-600">Delivery status<select className={inputClass} disabled={terminal} value={status} onChange={(event) => setStatuses((old) => ({ ...old, [order.id]: event.target.value as Status }))}>{order.deliveryStatus === "cancelled" ? <option value="cancelled">Cancelled</option> : null}<option value="packing">Packed</option><option value="shipped">Shipped</option><option value="out_for_delivery">Out for delivery</option><option value="delivered">Delivered</option></select></label><label className="text-xs font-semibold text-slate-600">Delivery partner<input className={inputClass} disabled={terminal} value={carrier[order.id] ?? order.deliveryPartner ?? ""} onChange={(event) => setCarrier((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="Courier / carrier"/></label><label className="text-xs font-semibold text-slate-600">Tracking number<input className={inputClass} disabled={terminal} value={tracking[order.id] ?? order.lrNumber ?? ""} onChange={(event) => setTracking((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="AWB / tracking ID"/></label><label className="text-xs font-semibold text-slate-600">Tracking URL<input className={inputClass} disabled={terminal} type="url" value={trackingUrl[order.id] ?? order.trackingUrl ?? ""} onChange={(event) => setTrackingUrl((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="https://… (optional)"/></label>
            <label className="text-xs font-semibold text-slate-600 sm:col-span-2">Tracking slip <input className="mt-1.5 block w-full text-xs" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={terminal || Boolean(existingSlip)} onChange={fileChange(order.id)}/><span className="mt-1 block font-normal text-slate-500">PDF, JPG, PNG, or WebP · up to 3 MB</span>{currentSlip ? <span className="mt-1 block text-emerald-800">Selected: {currentSlip.name}</span> : existingSlip ? <a className="mt-1 inline-block text-blue-700 underline" href={existingSlip.url} target="_blank" rel="noreferrer">View {existingSlip.fileName}</a> : null}</label>
            <div className="flex items-end"><button type="button" disabled={terminal || busy === order.id} onClick={() => void updateRetail(order)} className="h-10 w-full rounded-lg bg-[#174f40] px-4 text-sm font-bold text-white disabled:opacity-50">{busy === order.id ? "Saving…" : "Save order update →"}</button></div>
          </div>
          <a className="mt-3 inline-block text-xs font-semibold text-blue-700 underline" href={`/api/offline-sales/${order.id}/documents`} target="_blank" rel="noreferrer">View order documents</a>
        </article>;
      }) : <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Sales has not submitted any retail orders yet.</p>}
    </section>
  </section>;
}
