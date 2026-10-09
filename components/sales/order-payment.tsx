"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { OfflineSaleRow } from "@/types/offline-sales";

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value / 100);
const input = "mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm";

export function OrderPayment({ sale }: { sale: OfflineSaleRow }) {
  const router = useRouter();
  const proofInput = useRef<HTMLInputElement>(null);
  const submissionKey = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("upi");
  const [proof, setProof] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const remaining = sale.pendingAmountPaisa - Math.round((Number(amount) || 0) * 100);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!proof) { setError("Upload payment proof before saving."); return; }
    if (proof.size < 1 || proof.size > 3 * 1024 * 1024 || !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(proof.type)) { setError("Use a PDF, JPG, PNG, or WebP up to 3 MB."); return; }
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || remaining < 0) { setError("Enter an amount greater than zero and no more than the pending balance."); return; }
    const form = new FormData(event.currentTarget);
    form.set("proof", proof);
    submissionKey.current ??= crypto.randomUUID();
    setBusy(true);
    try {
      const response = await fetch(`/api/offline-sales/${sale.id}/collections`, { method: "POST", headers: { "Idempotency-Key": submissionKey.current }, body: form });
      const body = await response.json();
      if (!response.ok) {
        if (response.status < 500) submissionKey.current = null;
        throw new Error(body.error?.message ?? "Payment could not be saved.");
      }
      setNotice(`Payment and proof saved. Remaining balance: ${money(body.result.sale.pendingAmountPaisa)}.`);
      setOpen(false); setAmount(""); setProof(null); submissionKey.current = null; router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save. Retry to confirm the payment without duplicating it."); }
    finally { setBusy(false); }
  }

  return <div className="mt-3">
    {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
    {sale.deliveryStatus !== "cancelled" && sale.pendingAmountPaisa > 0 ? <button type="button" disabled={busy} onClick={() => setOpen(!open)} className="rounded-lg border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-800">{open ? "Close payment form" : "Update payment received"}</button> : null}
    {open ? <form onSubmit={save} className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="mb-3 text-sm">Already paid {money(sale.collectedAmountPaisa)} · Pending {money(sale.pendingAmountPaisa)}</p>
      {error ? <p role="alert" className="mb-3 text-sm text-rose-700">{error}</p> : null}
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Amount received now ₹<input name="amount" type="number" min="0.01" max={sale.pendingAmountPaisa / 100} step="0.01" required className={input} value={amount} onChange={event => setAmount(event.target.value)}/></label>
        <label className="text-sm">Payment mode<select name="paymentMode" className={input} value={mode} onChange={event => setMode(event.target.value)}><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="cheque">Cheque</option></select></label>
        <label className="text-sm">Received by<input name="paymentReceiverName" required className={input}/></label>
        <label className="text-sm">Transaction ID {mode === "cash" ? "(optional)" : ""}<input name="paymentTransactionId" required={mode !== "cash"} className={input}/></label>
        {remaining > 0 ? <label className="text-sm">Next payment expected<input name="expectedNextPaymentDate" type="date" required defaultValue={sale.expectedNextPaymentDate ?? ""} className={input}/></label> : null}
        <label className="text-sm">Notes (optional)<input name="notes" maxLength={1000} className={input}/></label>
        <div className="sm:col-span-2"><input ref={proofInput} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" aria-label="Payment proof" onChange={event => setProof(event.target.files?.[0] ?? null)}/><button type="button" onClick={() => proofInput.current?.click()} className="rounded-lg border border-emerald-600 bg-white px-3 py-2 text-sm font-semibold text-emerald-800">Upload payment proof</button><span className="ml-3 text-xs text-slate-600">{proof?.name ?? "PDF or image, up to 3 MB"}</span></div>
        <p className="text-sm font-semibold sm:col-span-2">Balance after payment: {money(Math.max(0, remaining))}</p>
        <button type="submit" className="rounded-lg bg-emerald-800 px-4 py-2 font-semibold text-white">{busy ? "Saving payment and proof…" : "Save payment"}</button>
      </fieldset>
    </form> : null}
  </div>;
}
