"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { normalizeInvoiceNumber } from "@/lib/sales/invoice-number";
import type { OfflineSaleRow } from "@/types/offline-sales";

export function OrderInvoice({ sale }: { sale: OfflineSaleRow }) {
  const router = useRouter();
  const [uploaded, setUploaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("kind", "invoice");
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/offline-sales/${sale.id}/documents`, { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Invoice upload failed. Please try again.");
      setUploaded(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invoice upload failed. Please try again.");
    } finally { setBusy(false); }
  }

  const numberPending = !normalizeInvoiceNumber(sale.billingInvoiceNumber ?? "");
  const numberReminder = numberPending ? <p role="status" className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm font-bold text-red-700">Invoice number is pending. Please update the invoice number using Edit invoice / order.</p> : null;

  if (sale.hasInvoice || uploaded) return <>{numberReminder} <p role="status" className="mt-3 text-sm font-semibold text-emerald-800">Invoice uploaded ✓</p></>;

  return <>{numberReminder}<div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3">
    <p role="status" className="text-sm font-bold text-red-700">Invoice is pending. Please upload invoice.</p>
    <form onSubmit={upload} className="mt-2">
      <fieldset disabled={busy} className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-slate-700">Invoice copy · PDF, JPG, PNG, or WebP, up to 3 MB
          <input name="file" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp" className="mt-1 block w-full text-sm"/>
        </label>
        <button type="submit" className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Uploading…" : "Upload invoice"}</button>
      </fieldset>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
    </form>
  </div></>;
}
