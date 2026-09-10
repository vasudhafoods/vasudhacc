"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { DashboardRole } from "@/types/auth";
import type { OfflineCustomerType, OfflineSaleRow, OfflineSalesOverview } from "@/types/offline-sales";

type SaleDraft = {
  saleDate: string;
  customerName: string;
  customerContact: string;
  customerType: OfflineCustomerType;
  isNewB2bCustomer: boolean;
  totalAmount: string;
  initialCollection: string;
  reference: string;
  notes: string;
};

function indiaToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

const initialDraft = (): SaleDraft => ({ saleDate: indiaToday(), customerName: "", customerContact: "", customerType: "retail", isNewB2bCustomer: false, totalAmount: "", initialCollection: "", reference: "", notes: "" });
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value / 100);
const inputClass = "mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";

function decimal(value: string): number {
  return /^\d+(?:\.\d{1,2})?$/.test(value.trim()) ? Math.round(Number(value) * 100) : 0;
}

function paymentStatus(total: number, collected: number): { label: string; className: string } {
  if (!total || collected <= 0) return { label: "Pending payment", className: "bg-amber-100 text-amber-800" };
  if (collected >= total) return { label: "Fully collected", className: "bg-emerald-100 text-emerald-800" };
  return { label: "Partially collected", className: "bg-blue-100 text-blue-800" };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

export function OfflineSalesWorkspace({ overview, role }: { overview: OfflineSalesOverview; role: DashboardRole }) {
  const router = useRouter();
  const [draft, setDraft] = useState<SaleDraft>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedSale, setSelectedSale] = useState<OfflineSaleRow | null>(null);
  const [collectionAmount, setCollectionAmount] = useState("");
  const [collectionReference, setCollectionReference] = useState("");
  const [collecting, setCollecting] = useState(false);

  const totalAmountPaisa = useMemo(() => decimal(draft.totalAmount), [draft.totalAmount]);
  const initialCollectionPaisa = useMemo(() => decimal(draft.initialCollection), [draft.initialCollection]);
  const draftStatus = paymentStatus(totalAmountPaisa, initialCollectionPaisa);
  const canSubmit = Boolean(draft.customerName.trim() && totalAmountPaisa > 0 && initialCollectionPaisa <= totalAmountPaisa);
  const isSalesOnly = role === "retail_sales";

  function update<K extends keyof SaleDraft>(key: K, value: SaleDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
    setSuccess(null);
  }

  async function submitSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      setError(initialCollectionPaisa > totalAmountPaisa ? "Collected amount cannot be greater than the sale amount." : "Enter customer name and a valid sale amount.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/offline-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(draft),
      });
      const body = await response.json() as { result?: { sale?: OfflineSaleRow; duplicate?: boolean }; error?: { message?: string } };
      if (!response.ok || !body.result?.sale) throw new Error(body.error?.message ?? "Offline sale could not be saved.");
      const sale = body.result.sale;
      setSuccess(`${sale.saleNumber} saved — ${money(sale.totalAmountPaisa)} sale, ${money(sale.collectedAmountPaisa)} collected, ${money(sale.pendingAmountPaisa)} pending.`);
      setDraft(initialDraft());
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Offline sale could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSale) return;
    const amountPaisa = decimal(collectionAmount);
    if (!amountPaisa || amountPaisa > selectedSale.pendingAmountPaisa) {
      setError(`Enter a collection up to ${money(selectedSale.pendingAmountPaisa)}.`);
      return;
    }
    setCollecting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/offline-sales/${selectedSale.id}/collections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ amount: collectionAmount, reference: collectionReference }),
      });
      const body = await response.json() as { result?: { sale?: OfflineSaleRow }; error?: { message?: string } };
      if (!response.ok || !body.result?.sale) throw new Error(body.error?.message ?? "Collection could not be saved.");
      const sale = body.result.sale;
      setSuccess(`Collection recorded for ${sale.customerName}. Remaining pending amount: ${money(sale.pendingAmountPaisa)}.`);
      setSelectedSale(null);
      setCollectionAmount("");
      setCollectionReference("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Collection could not be saved.");
    } finally {
      setCollecting(false);
    }
  }

  return <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-col gap-3 border-b border-slate-100 p-5 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-[#2d725f]">Offline sales desk</p><h2 className="mt-1 text-lg font-bold text-slate-950">Record a sale and payment in one place</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">Enter the sale amount and the amount actually collected. The system marks the balance as paid, partial, or pending automatically. Warehouse retail dispatch remains the stock record, so this form does not reduce stock again.</p></div><span className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${isSalesOnly ? "bg-blue-100 text-blue-800" : "bg-emerald-100 text-emerald-800"}`}>{isSalesOnly ? "Retail Sales workspace" : "Management entry enabled"}</span></div>
    <div className="space-y-5 p-5 sm:p-6">
      {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{error}</div> : null}
      {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950" role="status">{success}</div> : null}
      <form onSubmit={submitSale} className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h3 className="font-bold text-slate-900">New offline sale</h3><p className="mt-1 text-xs text-slate-500">Use one entry for one invoice, cash sale, B2B order, or retail sale.</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${draftStatus.className}`}>{draftStatus.label}</span></div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm font-semibold text-slate-700">Sale date<input type="date" value={draft.saleDate} onChange={(event) => update("saleDate", event.target.value)} className={inputClass} required/></label>
          <label className="text-sm font-semibold text-slate-700">Customer / business name<input value={draft.customerName} onChange={(event) => update("customerName", event.target.value)} className={inputClass} placeholder="Example: Sri Lakshmi Stores" required minLength={2} maxLength={160}/></label>
          <label className="text-sm font-semibold text-slate-700">Phone / contact <span className="font-normal text-slate-400">optional</span><input value={draft.customerContact} onChange={(event) => update("customerContact", event.target.value)} className={inputClass} placeholder="Phone or contact person" maxLength={80}/></label>
          <label className="text-sm font-semibold text-slate-700">Customer type<select value={draft.customerType} onChange={(event) => update("customerType", event.target.value as OfflineCustomerType)} className={inputClass}><option value="retail">Retail customer</option><option value="b2b">B2B customer</option></select></label>
          <label className="text-sm font-semibold text-slate-700">Total sale amount (₹)<input inputMode="decimal" value={draft.totalAmount} onChange={(event) => update("totalAmount", event.target.value)} className={inputClass} placeholder="0.00" required/></label>
          <label className="text-sm font-semibold text-slate-700">Amount collected now (₹)<input inputMode="decimal" value={draft.initialCollection} onChange={(event) => update("initialCollection", event.target.value)} className={inputClass} placeholder="0.00 for pending"/></label>
          <label className="text-sm font-semibold text-slate-700">Invoice / reference <span className="font-normal text-slate-400">optional</span><input value={draft.reference} onChange={(event) => update("reference", event.target.value)} className={inputClass} placeholder="Bill no., PO, UPI ref." maxLength={120}/></label>
          <label className="flex items-end gap-3 rounded-lg border border-emerald-100 bg-white px-3 py-3 text-sm font-semibold text-slate-700"><input type="checkbox" checked={draft.isNewB2bCustomer} disabled={draft.customerType !== "b2b"} onChange={(event) => update("isNewB2bCustomer", event.target.checked)} className="size-4 accent-emerald-700"/>New B2B customer onboarded</label>
        </div>
        <label className="mt-4 block text-sm font-semibold text-slate-700">Notes <span className="font-normal text-slate-400">optional</span><textarea value={draft.notes} onChange={(event) => update("notes", event.target.value)} className="mt-1.5 min-h-20 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" placeholder="Payment terms, delivery note, or any important context" maxLength={1000}/></label>
        <div className="mt-5 flex flex-col gap-3 border-t border-emerald-100 pt-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-slate-600">{totalAmountPaisa ? <>Sale: <strong>{money(totalAmountPaisa)}</strong> · Collected: <strong>{money(initialCollectionPaisa)}</strong> · Pending: <strong>{money(Math.max(0, totalAmountPaisa - initialCollectionPaisa))}</strong></> : "Enter the sale amount to see the collection summary."}</p><button type="submit" disabled={submitting || !canSubmit} className="h-11 rounded-lg bg-[#174f40] px-5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60">{submitting ? "Saving sale…" : "Save offline sale"}</button></div>
      </form>

      {selectedSale ? <form onSubmit={submitCollection} className="rounded-xl border border-blue-200 bg-blue-50 p-4 sm:flex sm:items-end sm:gap-4"><div className="min-w-0 flex-1"><p className="text-sm font-bold text-blue-950">Record collection from {selectedSale.customerName}</p><p className="mt-1 text-xs text-blue-800">Pending balance: {money(selectedSale.pendingAmountPaisa)}</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-blue-950">Amount received (₹)<input autoFocus inputMode="decimal" value={collectionAmount} onChange={(event) => { setCollectionAmount(event.target.value); setError(null); }} className={inputClass} placeholder="0.00" required/></label><label className="text-xs font-semibold text-blue-950">Receipt / UPI reference <span className="font-normal">optional</span><input value={collectionReference} onChange={(event) => setCollectionReference(event.target.value)} className={inputClass} placeholder="Reference number" maxLength={120}/></label></div></div><div className="mt-3 flex gap-2 sm:mt-0"><button type="button" onClick={() => { setSelectedSale(null); setCollectionAmount(""); setCollectionReference(""); }} className="h-11 rounded-lg border border-blue-200 bg-white px-4 text-sm font-bold text-blue-800">Cancel</button><button type="submit" disabled={collecting} className="h-11 rounded-lg bg-blue-700 px-4 text-sm font-bold text-white disabled:opacity-60">{collecting ? "Saving…" : "Record collection"}</button></div></form> : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <SalesTable title="Sales in this period" subtitle={`${overview.salesCount} invoice${overview.salesCount === 1 ? "" : "s"} recorded in the selected date range.`} sales={overview.recentSales} onCollect={setSelectedSale}/>
        <SalesTable title="Pending collections" subtitle="Open balances across all offline invoices, highest amount first." sales={overview.outstandingSales} onCollect={setSelectedSale} pending/>
      </div>
    </div>
  </section>;
}

function SalesTable({ title, subtitle, sales, onCollect, pending = false }: { title: string; subtitle: string; sales: OfflineSaleRow[]; onCollect: (sale: OfflineSaleRow) => void; pending?: boolean }) {
  return <div className="overflow-hidden rounded-xl border border-slate-200"><div className="border-b border-slate-100 p-4"><h3 className="text-sm font-bold text-slate-900">{title}</h3><p className="mt-1 text-xs text-slate-500">{subtitle}</p></div>{sales.length ? <div className="divide-y divide-slate-100">{sales.map((sale) => { const status = paymentStatus(sale.totalAmountPaisa, sale.collectedAmountPaisa); return <div key={sale.id} className="p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-bold text-slate-800">{sale.customerName}</p><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${sale.customerType === "b2b" ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-600"}`}>{sale.customerType === "b2b" ? "B2B" : "Retail"}</span>{sale.isNewB2bCustomer ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">New B2B</span> : null}</div><p className="mt-1 text-xs text-slate-500">{sale.saleNumber} · {formatDate(sale.saleDate)}{sale.reference ? ` · ${sale.reference}` : ""}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${status.className}`}>{status.label}</span></div><div className="mt-3 grid grid-cols-3 gap-2 text-xs"><Amount label="Sale" value={money(sale.totalAmountPaisa)}/><Amount label="Collected" value={money(sale.collectedAmountPaisa)} tone="green"/><Amount label="Pending" value={money(sale.pendingAmountPaisa)} tone={sale.pendingAmountPaisa ? "amber" : "green"}/></div>{sale.pendingAmountPaisa > 0 ? <button type="button" onClick={() => onCollect(sale)} className="mt-3 text-xs font-bold text-blue-700 hover:underline">Record a payment →</button> : null}</div>; })}</div> : <div className="p-8 text-center text-sm text-slate-500">{pending ? "No payments are pending." : "No offline sales have been recorded in this period."}</div>}</div>;
}

function Amount({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "green" | "amber" }) {
  const color = tone === "green" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : "text-slate-800";
  return <div className="rounded-lg bg-slate-50 px-2.5 py-2"><p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p><p className={`mt-1 font-bold ${color}`}>{value}</p></div>;
}
