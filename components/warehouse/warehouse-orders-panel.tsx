"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import type { OfflineSaleRow } from "@/types/offline-sales";
import type { ShopifyWarehouseOrder } from "@/types/warehouse";

type Status = "packing" | "shipped" | "out_for_delivery" | "delivered";
type Slip = { fileName: string; url: string };
type ShopifyOrderFilter = "all" | "unfulfilled" | "partially_fulfilled" | "fulfilled";

function displayShopifyStatus(value: string | null | undefined): string {
  if (!value) return "—";
  const labels: Record<string, string> = {
    OPEN: "Unfulfilled",
    UNFULFILLED: "Unfulfilled",
    PENDING_FULFILLMENT: "Unfulfilled",
    PARTIALLY_FULFILLED: "Partially fulfilled",
    FULFILLED: "Fulfilled",
    IN_PROGRESS: "In progress",
    AUTHORIZED: "Authorized",
    PAID: "Paid",
    PARTIALLY_PAID: "Partially paid",
    PENDING: "Pending",
    REFUNDED: "Refunded",
    VOIDED: "Voided",
    IN_TRANSIT: "In transit",
    OUT_FOR_DELIVERY: "Out for delivery",
    DELIVERED: "Delivered",
    TRACKING_ADDED: "Tracking added",
    ATTEMPTED_DELIVERY: "Delivery attempted",
    DELAYED: "Delayed",
    FAILURE: "Delivery issue",
    CANCELED: "Cancelled",
  };
  return labels[value] ?? value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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
  const [selectedSlip, setSelectedSlip] = useState<Record<string, File | null>>({});
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [savedStatuses, setSavedStatuses] = useState<Record<string, string>>({});
  const [shopifySearch, setShopifySearch] = useState("");
  const [shopifyFilter, setShopifyFilter] = useState<ShopifyOrderFilter>("all");

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

  const inputClass = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";
  const fileChange = (orderId: string) => (event: ChangeEvent<HTMLInputElement>) => setSelectedSlip((current) => ({ ...current, [orderId]: event.target.files?.[0] ?? null }));
  const visibleShopifyOrders = useMemo(() => {
    const search = shopifySearch.trim().toLocaleLowerCase();
    return shopifyOrders.filter((order) => {
      const status = order.fulfillmentStatus.toUpperCase();
      const matchesFilter = shopifyFilter === "all"
        || (shopifyFilter === "unfulfilled" && ["OPEN", "UNFULFILLED", "PENDING_FULFILLMENT"].includes(status))
        || (shopifyFilter === "partially_fulfilled" && status === "PARTIALLY_FULFILLED")
        || (shopifyFilter === "fulfilled" && status === "FULFILLED");
      const searchText = [order.name, order.customerName, order.destination, order.sourceName, ...order.trackingInfo.flatMap((info) => [info.number, info.company])].filter(Boolean).join(" ").toLocaleLowerCase();
      return matchesFilter && (!search || searchText.includes(search));
    });
  }, [shopifyOrders, shopifySearch, shopifyFilter]);

  return <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
    <header><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Warehouse desk</p><h2 className="mt-1 text-2xl font-bold text-slate-950">Orders</h2><p className="mt-1 text-sm text-slate-500">Fulfill Shopify shipments in Delhivery. Refresh here to see tracking and delivery details synced to Shopify. Retail orders from Sales are updated below.</p></header>
    {message ? <p role="status" aria-live="polite" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p> : null}
    {migrationPending ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Sales order database updates are pending. Run <code className="font-bold">npm run db:migrate</code> and refresh.</p> : null}

    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-lg font-bold text-slate-900">Shopify orders</h3><p className="text-xs text-slate-500">Latest 50 orders, including fulfillment and tracking updates from Shopify.</p></div>
        <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-bold text-violet-800">{shopifyOrders.length} orders</span>
      </div>
      {shopifyOrdersError ? <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">Couldn’t load Shopify orders: {shopifyOrdersError}. Confirm that the Shopify app has the <code>read_orders</code> scope.</p> : <>
        <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row">
          <label className="sr-only" htmlFor="shopify-order-filter">Filter Shopify orders</label>
          <select id="shopify-order-filter" className={`${inputClass} sm:w-52`} value={shopifyFilter} onChange={(event) => setShopifyFilter(event.target.value as ShopifyOrderFilter)}>
            <option value="all">All orders</option><option value="unfulfilled">Unfulfilled</option><option value="partially_fulfilled">Partially fulfilled</option><option value="fulfilled">Fulfilled</option>
          </select>
          <label className="sr-only" htmlFor="shopify-order-search">Search Shopify orders</label>
          <input id="shopify-order-search" className={inputClass} type="search" value={shopifySearch} onChange={(event) => setShopifySearch(event.target.value)} placeholder="Search order, customer, AWB, or tracking ID"/>
          <button type="button" onClick={() => router.refresh()} className="h-10 shrink-0 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100">Refresh orders</button>
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-600"><tr>{["Order", "Date ↓", "Customer", "Fulfillment status", "Payment status", "Total", "Delivery status", "Tracking ID", "Channel", "Items"].map((heading) => <th key={heading} className="whitespace-nowrap border-b border-slate-200 px-3 py-3">{heading}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {visibleShopifyOrders.map((order) => {
                const fulfillmentStatus = order.fulfillmentStatus.toUpperCase();
                const fulfillmentTone = fulfillmentStatus === "FULFILLED" ? "bg-slate-100 text-slate-700" : ["PARTIALLY_FULFILLED", "IN_PROGRESS"].includes(fulfillmentStatus) ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-900";
                const deliveryTone = order.deliveryStatus === "DELIVERED" ? "bg-emerald-100 text-emerald-800" : order.deliveryStatus === "IN_TRANSIT" || order.deliveryStatus === "OUT_FOR_DELIVERY" ? "bg-cyan-100 text-cyan-900" : "bg-slate-100 text-slate-700";
                return <tr key={order.id} className="align-top hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-3 font-semibold text-slate-900">{order.name}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-600">{new Date(order.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}</td>
                  <td className="max-w-56 px-3 py-3 text-slate-700">{order.customerName}</td>
                  <td className="px-3 py-3"><span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${fulfillmentTone}`}>{displayShopifyStatus(order.fulfillmentStatus)}</span></td>
                  <td className="px-3 py-3"><span className="whitespace-nowrap rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{displayShopifyStatus(order.financialStatus)}</span></td>
                  <td className="whitespace-nowrap px-3 py-3 font-medium text-slate-800">{order.currency} {Number(order.total).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-3">{order.deliveryStatus ? <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${deliveryTone}`}>{displayShopifyStatus(order.deliveryStatus)}</span> : <span className="text-slate-400">—</span>}</td>
                  <td className="max-w-48 px-3 py-3">{order.trackingInfo.length ? <div className="space-y-1">{order.trackingInfo.map((info, index) => <div key={`${order.id}-tracking-${index}`}><span className="block text-[11px] text-slate-500">{info.company || "Carrier"}</span>{info.url ? <a className="break-all font-semibold text-blue-700 underline" href={info.url} target="_blank" rel="noreferrer">{info.number || "Open tracking"}</a> : <span className="break-all font-semibold text-slate-800">{info.number || "—"}</span>}</div>)}</div> : <span className="text-slate-400">—</span>}</td>
                  <td className="max-w-40 px-3 py-3 text-slate-600">{order.sourceName}</td>
                  <td className="min-w-64 max-w-80 px-3 py-3 text-slate-700">
                    <p className="mb-1 text-xs font-semibold text-slate-500">{order.itemCount} {order.itemCount === 1 ? "unit" : "units"}</p>
                    {order.lines.length ? <ul className="space-y-1">{order.lines.map((line, index) => <li key={`${order.id}-item-${index}`} className="text-xs leading-5">
                      <span className="font-medium text-slate-800">{line.title}</span>{line.variantTitle ? <span className="text-slate-500"> · {line.variantTitle}</span> : null}{line.sku ? <span className="text-slate-500"> · {line.sku}</span> : null}<span className="font-semibold text-slate-700"> × {line.quantity}</span>
                    </li>)}</ul> : <span className="text-slate-400">—</span>}
                  </td>
                </tr>;
              })}
              {!visibleShopifyOrders.length ? <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-slate-500">{shopifyOrders.length ? "No orders match this search or filter." : "No Shopify orders found."}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </>}
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
