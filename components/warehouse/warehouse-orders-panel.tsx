"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { normalizeInvoiceNumber } from "@/lib/sales/invoice-number";
import type { OfflineSaleRow } from "@/types/offline-sales";
import type { ShopifyWarehouseOrder } from "@/types/warehouse";

type Status = "packing" | "shipped" | "out_for_delivery" | "delivered";
type OrderDocument = { fileName: string; url: string };
type OrderDocumentKind = "tracking_slip" | "proof_of_delivery";
type OrderDocumentView = OrderDocument & { kind: string; contentType: string; createdAt: string; isCurrentInvoice?: boolean };
type ShopifyOrderFilter = "all" | "unfulfilled" | "partially_fulfilled" | "fulfilled";
type OrderTab = "shopify" | "retail";

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

export function WarehouseOrdersPanel({ salesOrders, shopifyOrders, shopifyOrdersError, migrationPending, documents }: {
  salesOrders: OfflineSaleRow[];
  shopifyOrders: ShopifyWarehouseOrder[];
  shopifyOrdersError: string | null;
  migrationPending: boolean;
  documents: Record<string, OrderDocument>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [carrier, setCarrier] = useState<Record<string, string>>({});
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [trackingUrl, setTrackingUrl] = useState<Record<string, string>>({});
  const [selectedDocuments, setSelectedDocuments] = useState<Record<string, File | null>>({});
  const [expandedDocuments, setExpandedDocuments] = useState<Record<string, boolean>>({});
  const [orderDocumentLists, setOrderDocumentLists] = useState<Record<string, OrderDocumentView[]>>({});
  const [loadingDocuments, setLoadingDocuments] = useState<Record<string, boolean>>({});
  const [documentErrors, setDocumentErrors] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [savedStatuses, setSavedStatuses] = useState<Record<string, string>>({});
  const [shopifySearch, setShopifySearch] = useState("");
  const [shopifyFilter, setShopifyFilter] = useState<ShopifyOrderFilter>("all");
  const [activeOrderTab, setActiveOrderTab] = useState<OrderTab>("shopify");

  async function updateRetail(order: OfflineSaleRow) {
    const currentStatus = savedStatuses[order.id] ?? order.deliveryStatus;
    const status = statuses[order.id] ?? (currentStatus === "dispatched" ? "delivered" : currentStatus as Status);
    setBusy(order.id); setMessage(""); setMessageError(false);
    try {
      const response = await fetch(`/api/warehouse/offline-sales/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, deliveryPartner: carrier[order.id] ?? order.deliveryPartner ?? "", trackingNumber: tracking[order.id] ?? order.lrNumber ?? "", trackingUrl: trackingUrl[order.id] ?? order.trackingUrl ?? "" }) });
      const body = await response.json() as { result?: { status?: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Retail order could not be updated.");
      setSavedStatuses((old) => ({ ...old, [order.id]: body.result?.status ?? status }));
      setStatuses((old) => { const next = { ...old }; delete next[order.id]; return next; });
      setMessage(`Order ${order.billingInvoiceNumber ?? order.saleNumber} updated to ${status.replaceAll("_", " ")}.`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Retail order could not be updated."); setMessageError(true); }
    finally { setBusy(""); }
  }

  async function uploadRetailDocument(order: OfflineSaleRow, kind: OrderDocumentKind) {
    const key = `${order.id}:${kind}`;
    const file = selectedDocuments[key];
    if (!file) { setMessage("Choose a file before uploading."); setMessageError(true); return; }
    setBusy(key); setMessage(""); setMessageError(false);
    try {
      const form = new FormData(); form.set("kind", kind); form.set("file", file);
      const response = await fetch(`/api/offline-sales/${order.id}/documents`, { method: "POST", body: form });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "File could not be uploaded.");
      setSelectedDocuments((old) => ({ ...old, [key]: null }));
      setMessage(`${kind === "tracking_slip" ? "Tracking slip" : "Proof of delivery"} uploaded for ${order.billingInvoiceNumber ?? order.saleNumber}.`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "File could not be uploaded."); setMessageError(true); }
    finally { setBusy(""); }
  }

  async function toggleOrderDocuments(order: OfflineSaleRow) {
    const orderId = order.id;
    if (expandedDocuments[orderId]) {
      setExpandedDocuments((old) => ({ ...old, [orderId]: false }));
      return;
    }
    setExpandedDocuments((old) => ({ ...old, [orderId]: true }));
    setDocumentErrors((old) => ({ ...old, [orderId]: "" }));
    if (orderDocumentLists[orderId]) return;
    setLoadingDocuments((old) => ({ ...old, [orderId]: true }));
    try {
      const response = await fetch(`/api/offline-sales/${orderId}/documents`, { cache: "no-store" });
      const body = await response.json() as { files?: OrderDocumentView[]; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Order documents could not be loaded.");
      setOrderDocumentLists((old) => ({ ...old, [orderId]: body.files ?? [] }));
    } catch (error) {
      setDocumentErrors((old) => ({ ...old, [orderId]: error instanceof Error ? error.message : "Order documents could not be loaded." }));
    } finally {
      setLoadingDocuments((old) => ({ ...old, [orderId]: false }));
    }
  }

  const inputClass = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";
  const fileChange = (orderId: string, kind: OrderDocumentKind) => (event: ChangeEvent<HTMLInputElement>) => setSelectedDocuments((current) => ({ ...current, [`${orderId}:${kind}`]: event.target.files?.[0] ?? null }));
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
    <header><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Warehouse desk</p><h2 className="mt-1 text-2xl font-bold text-slate-950">Orders</h2><p className="mt-1 text-sm text-slate-500">Switch between Shopify shipments and Retail orders from Sales. Shopify tracking updates appear here after syncing from Delhivery.</p></header>
    {message ? <p role={messageError ? "alert" : "status"} aria-live="polite" className={`rounded-lg border p-3 text-sm ${messageError ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{message}</p> : null}
    {migrationPending ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Sales order database updates are pending. Run <code className="font-bold">npm run db:migrate</code> and refresh.</p> : null}

    <div role="tablist" aria-label="Order type" className="flex gap-2 rounded-xl border border-slate-200 bg-slate-50 p-1.5">
      <button type="button" role="tab" aria-selected={activeOrderTab === "shopify"} onClick={() => setActiveOrderTab("shopify")} className={`flex-1 rounded-lg px-4 py-3 text-sm font-semibold transition ${activeOrderTab === "shopify" ? "bg-white text-emerald-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white/70"}`}>
        Shopify <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">{shopifyOrders.length}</span>
      </button>
      <button type="button" role="tab" aria-selected={activeOrderTab === "retail"} onClick={() => setActiveOrderTab("retail")} className={`flex-1 rounded-lg px-4 py-3 text-sm font-semibold transition ${activeOrderTab === "retail" ? "bg-white text-emerald-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white/70"}`}>
        Retail <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">{salesOrders.length}</span>
      </button>
    </div>

    {activeOrderTab === "shopify" ? <section role="tabpanel" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-lg font-bold text-slate-900">Shopify orders</h3><p className="text-xs text-slate-500">Latest 50 orders, including fulfillment and tracking updates from Shopify.</p></div>
        <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">{shopifyOrders.length} orders</span>
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
          <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-600"><tr>{["Order", "Date ↓", "Customer", "Fulfillment status", "Payment status", "Total", "Delivery status", "Tracking ID", "Items to pack"].map((heading) => <th key={heading} className="whitespace-nowrap border-b border-slate-200 px-3 py-3">{heading}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {visibleShopifyOrders.map((order) => {
                const fulfillmentStatus = order.fulfillmentStatus.toUpperCase();
                const fulfillmentTone = fulfillmentStatus === "FULFILLED" ? "bg-slate-100 text-slate-700" : ["PARTIALLY_FULFILLED", "IN_PROGRESS"].includes(fulfillmentStatus) ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900";
                const deliveryTone = order.deliveryStatus === "DELIVERED" ? "bg-emerald-100 text-emerald-800" : order.deliveryStatus === "IN_TRANSIT" || order.deliveryStatus === "OUT_FOR_DELIVERY" ? "bg-cyan-100 text-cyan-900" : "bg-slate-100 text-slate-700";
                return <tr key={order.id} className="align-top hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-3 font-semibold text-slate-900">{order.name}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-600"><span className="block">{new Date(order.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}</span><span className="mt-1 block text-xs text-slate-500">{new Date(order.createdAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}</span></td>
                  <td className="max-w-56 px-3 py-3 text-slate-700">{order.customerName}</td>
                  <td className="px-3 py-3"><span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${fulfillmentTone}`}>{displayShopifyStatus(order.fulfillmentStatus)}</span></td>
                  <td className="px-3 py-3"><span className="whitespace-nowrap rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{displayShopifyStatus(order.financialStatus)}</span></td>
                  <td className="whitespace-nowrap px-3 py-3 font-medium text-slate-800">{order.currency} {Number(order.total).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-3">{order.deliveryStatus ? <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${deliveryTone}`}>{displayShopifyStatus(order.deliveryStatus)}</span> : <span className="text-slate-400">—</span>}</td>
                  <td className="max-w-48 px-3 py-3">{order.trackingInfo.length ? <div className="space-y-1">{order.trackingInfo.map((info, index) => <div key={`${order.id}-tracking-${index}`}><span className="block text-[11px] text-slate-500">{info.company || "Carrier"}</span>{info.url ? <a className="break-all font-semibold text-emerald-700 underline" href={info.url} target="_blank" rel="noreferrer">{info.number || "Open tracking"}</a> : <span className="break-all font-semibold text-slate-800">{info.number || "—"}</span>}</div>)}</div> : <span className="text-slate-400">—</span>}</td>
                  <td className="min-w-[320px] max-w-[420px] px-3 py-3 text-slate-700">
                    <p className="mb-1 text-xs font-semibold text-slate-500">{order.itemCount} {order.itemCount === 1 ? "unit" : "units"}</p>
                    {order.lines.length ? <ul className="space-y-1">{order.lines.map((line, index) => <li key={`${order.id}-item-${index}`} className="text-xs leading-5">
                      <span className="font-medium text-slate-800">{line.title}</span>{line.variantTitle ? <span className="text-slate-500"> · {line.variantTitle}</span> : null}{line.sku ? <span className="text-slate-500"> · {line.sku}</span> : null}<span className="font-semibold text-slate-700"> × {line.quantity}</span>
                    </li>)}</ul> : <span className="text-slate-400">—</span>}
                  </td>
                </tr>;
              })}
              {!visibleShopifyOrders.length ? <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-500">{shopifyOrders.length ? "No orders match this search or filter." : "No Shopify orders found."}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </>}
    </section> : null}

    {activeOrderTab === "retail" ? <section role="tabpanel" className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-lg font-bold text-slate-900">Retail orders from Sales</h3><p className="text-xs text-slate-500">Stock is issued when an order is marked shipped.</p></div><span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">{salesOrders.filter((order) => !["delivered", "cancelled"].includes(order.deliveryStatus)).length} active · {salesOrders.length} total</span></div>
      {salesOrders.length ? salesOrders.map((order) => {
        const savedStatus = savedStatuses[order.id] ?? order.deliveryStatus;
        const status = statuses[order.id] ?? (savedStatus === "dispatched" ? "delivered" : savedStatus as Status);
        const terminal = ["delivered", "cancelled"].includes(savedStatus);
        const trackingKey = `${order.id}:tracking_slip`;
        const proofKey = `${order.id}:proof_of_delivery`;
        const currentSlip = selectedDocuments[trackingKey];
        const currentProof = selectedDocuments[proofKey];
        const existingSlip = documents[trackingKey];
        const existingProof = documents[proofKey];
        return <article key={order.id} className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-4"><div className="flex flex-wrap justify-between gap-3"><div><h4 className="font-bold text-slate-900">{order.billingInvoiceNumber ?? order.saleNumber} · {order.customerName}</h4><p className="mt-1 text-xs text-slate-500">{new Date(order.saleDate).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })} · {order.shippingAddress || "No shipping address"}</p><p className="mt-1 text-sm font-semibold">₹{(order.totalAmountPaisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</p>{savedStatus === "delivered" && order.deliveredAt ? <p className="mt-1 text-sm font-semibold text-emerald-800">Delivered on {new Date(order.deliveredAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}</p> : null}</div><div className="flex h-fit flex-wrap items-center gap-2"><span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold capitalize text-emerald-900">{savedStatus.replaceAll("_", " ")}</span>{order.requestedDispatchDate ? <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">Dispatch by {new Date(`${order.requestedDispatchDate}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}</span> : null}</div></div>
          {!normalizeInvoiceNumber(order.billingInvoiceNumber ?? "") ? <p className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm font-bold text-red-700">Invoice number is pending. Please update the invoice number.</p> : null}
          {documents[`${order.id}:invoice`] ? <p className="mt-3 text-sm font-semibold text-emerald-800">Invoice uploaded ✓</p> : <p className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm font-bold text-red-700">Invoice is pending. Please upload invoice.</p>}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">{order.lines.map((line, index) => <p key={`${order.id}-${index}`} className="rounded-lg bg-white px-3 py-2 text-xs text-slate-700">{line.productName} × {line.quantity}</p>)}</div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><label className="text-xs font-semibold text-slate-600">Delivery status<select className={inputClass} disabled={terminal} value={status} onChange={(event) => setStatuses((old) => ({ ...old, [order.id]: event.target.value as Status }))}>{order.deliveryStatus === "cancelled" ? <option value="cancelled">Cancelled</option> : null}<option value="packing">Packed</option><option value="shipped">Shipped</option><option value="out_for_delivery">Out for delivery</option><option value="delivered">Delivered</option></select></label><label className="text-xs font-semibold text-slate-600">Delivery partner<input className={inputClass} disabled={terminal} value={carrier[order.id] ?? order.deliveryPartner ?? ""} onChange={(event) => setCarrier((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="Courier / carrier"/></label><label className="text-xs font-semibold text-slate-600">Tracking number<input className={inputClass} disabled={terminal} value={tracking[order.id] ?? order.lrNumber ?? ""} onChange={(event) => setTracking((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="AWB / tracking ID"/></label><label className="text-xs font-semibold text-slate-600">Tracking URL <span className="font-normal text-slate-500">(optional)</span><input className={inputClass} disabled={terminal} type="url" value={trackingUrl[order.id] ?? order.trackingUrl ?? ""} onChange={(event) => setTrackingUrl((old) => ({ ...old, [order.id]: event.target.value }))} placeholder="https://…"/></label>
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs sm:col-span-2"><p className="font-semibold text-slate-700">Tracking slip</p><div className="mt-2 flex flex-wrap items-center gap-2"><label className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-slate-300 px-3 font-semibold text-slate-700 hover:bg-slate-50">Choose file<input className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={fileChange(order.id, "tracking_slip")}/></label><button type="button" disabled={!currentSlip || busy === trackingKey} onClick={() => void uploadRetailDocument(order, "tracking_slip")} className="h-9 rounded-lg bg-emerald-700 px-3 font-semibold text-white disabled:opacity-50">{busy === trackingKey ? "Uploading…" : "Upload tracking slip"}</button>{currentSlip ? <span className="text-slate-600">{currentSlip.name}</span> : null}{existingSlip ? <a className="font-semibold text-emerald-700 underline" href={existingSlip.url} target="_blank" rel="noreferrer">View latest: {existingSlip.fileName}</a> : null}</div><p className="mt-1 text-slate-500">PDF, JPG, PNG, or WebP · up to 3 MB</p></div>
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs sm:col-span-2"><p className="font-semibold text-slate-700">Proof of delivery</p><div className="mt-2 flex flex-wrap items-center gap-2"><label className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-slate-300 px-3 font-semibold text-slate-700 hover:bg-slate-50">Choose file<input className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={fileChange(order.id, "proof_of_delivery")}/></label><button type="button" disabled={!currentProof || busy === proofKey} onClick={() => void uploadRetailDocument(order, "proof_of_delivery")} className="h-9 rounded-lg bg-emerald-700 px-3 font-semibold text-white disabled:opacity-50">{busy === proofKey ? "Uploading…" : "Upload proof of delivery"}</button>{currentProof ? <span className="text-slate-600">{currentProof.name}</span> : null}{existingProof ? <a className="font-semibold text-emerald-700 underline" href={existingProof.url} target="_blank" rel="noreferrer">View latest: {existingProof.fileName}</a> : null}</div><p className="mt-1 text-slate-500">PDF, JPG, PNG, or WebP · up to 3 MB</p></div>
            <div className="flex items-end"><button type="button" disabled={terminal || busy === order.id} onClick={() => void updateRetail(order)} className="h-10 w-full rounded-lg bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50">{busy === order.id ? "Saving…" : "Save order update →"}</button></div>
          </div>
          <button type="button" onClick={() => void toggleOrderDocuments(order)} className="mt-3 text-xs font-semibold text-emerald-700 underline">{expandedDocuments[order.id] ? "Hide order documents" : "View order documents"}</button>
          {expandedDocuments[order.id] ? <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3 text-sm">
            {loadingDocuments[order.id] ? <p className="text-slate-500">Loading documents…</p> : documentErrors[order.id] ? <p role="alert" className="text-rose-700">{documentErrors[order.id]}</p> : orderDocumentLists[order.id]?.length ? <ul className="space-y-2">{orderDocumentLists[order.id].map((document) => <li key={document.url} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2"><div><p className="font-semibold text-slate-800">{document.fileName}</p><p className="text-xs capitalize text-slate-500">{document.kind === "invoice" ? document.isCurrentInvoice ? "Current invoice" : "Previous invoice" : document.kind.replaceAll("_", " ")} · {new Date(document.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}</p></div><a className="font-semibold text-emerald-700 underline" href={document.url} target="_blank" rel="noreferrer">Open document</a></li>)}</ul> : <p className="text-slate-500">No documents have been uploaded for this order yet.</p>}
          </div> : null}
        </article>;
      }) : <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Sales has not submitted any retail orders yet.</p>}
    </section> : null}
  </section>;
}
