"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { WarehouseStaffAccount } from "@/services/staff-accounts";

export function StaffAccountsPanel({ initialAccounts }: { initialAccounts: WarehouseStaffAccount[] }) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resettingAccount, setResettingAccount] = useState<WarehouseStaffAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      const response = await fetch("/api/admin/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: formData.get("displayName"),
          username: formData.get("username"),
          password: formData.get("password"),
          role: formData.get("role"),
        }),
      });
      const body = await response.json() as { account?: WarehouseStaffAccount; error?: { message?: string } };
      if (!response.ok || !body.account) throw new Error(body.error?.message ?? "Account could not be created.");
      setSuccess(`${body.account.displayName} can now sign in with username “${body.account.username}”. Share the temporary password securely.`);
      form.reset();
      setShowForm(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account could not be created.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleAccount(account: WarehouseStaffAccount) {
    setBusyId(account.id);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/admin/staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, active: !account.active }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Account could not be updated.");
      setSuccess(`${account.displayName}'s access is now ${account.active ? "disabled" : "active"}.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resettingAccount) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get("newPassword") ?? "");
    setBusyId(resettingAccount.id);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/admin/staff", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: resettingAccount.id, password }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Password could not be replaced.");
      setSuccess(`${resettingAccount.displayName}'s password was replaced. Share the new password securely.`);
      setResettingAccount(null);
      form.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Password could not be replaced.");
    } finally {
      setBusyId(null);
    }
  }

  const inputClass = "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";
  return <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-col gap-4 border-b border-slate-100 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Access control</p><h2 className="mt-1 text-lg font-bold text-slate-950">Warehouse staff accounts</h2><p className="mt-1 text-sm text-slate-500">Staff see only Receive stock, Add product, and My updates.</p></div>
      <button type="button" onClick={() => { setShowForm((current) => !current); setError(null); }} className="h-11 rounded-lg bg-[#174f40] px-5 text-sm font-bold text-white">{showForm ? "Close form" : "Add warehouse user"}</button>
    </div>
    <div className="space-y-5 p-5 sm:p-6">
      {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{error}</div> : null}
      {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status">{success}</div> : null}
      {showForm ? <form className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 sm:p-5" onSubmit={createAccount}>
        <h3 className="font-bold text-slate-900">Create sign-in details</h3><p className="mt-1 text-xs leading-5 text-slate-500">The password is stored as a one-way secure hash. It cannot be viewed later.</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold text-slate-700">Staff name<input name="displayName" className={`${inputClass} mt-2`} placeholder="Example: Ramesh Kumar" required minLength={2}/></label><label className="text-sm font-semibold text-slate-700">Username<input name="username" className={`${inputClass} mt-2 lowercase`} placeholder="Example: ramesh.warehouse" required minLength={3} pattern="[A-Za-z0-9._-]+"/></label><label className="text-sm font-semibold text-slate-700">Temporary password<input name="password" type="password" className={`${inputClass} mt-2`} placeholder="At least 12 characters" required minLength={12}/><span className="mt-1 block text-xs font-normal text-slate-500">Include at least one letter and one number.</span></label><label className="text-sm font-semibold text-slate-700">Role<select name="role" className={`${inputClass} mt-2`} defaultValue="warehouse_staff"><option value="warehouse_staff">Warehouse staff</option><option value="warehouse_manager">Warehouse manager</option></select></label></div>
        <div className="mt-5 flex justify-end"><button type="submit" disabled={submitting} className="h-11 rounded-lg bg-[#174f40] px-5 text-sm font-bold text-white disabled:opacity-60">{submitting ? "Creating…" : "Create warehouse login"}</button></div>
      </form> : null}

      {resettingAccount ? <form className="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex sm:items-end sm:gap-4" onSubmit={resetPassword}><label className="block flex-1 text-sm font-semibold text-slate-800">New password for {resettingAccount.displayName}<input name="newPassword" type="password" className={`${inputClass} mt-2`} placeholder="At least 12 characters, with a letter and number" minLength={12} required autoFocus/></label><div className="mt-3 flex gap-2 sm:mt-0"><button type="button" onClick={() => setResettingAccount(null)} className="h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700">Cancel</button><button type="submit" disabled={busyId === resettingAccount.id} className="h-11 rounded-lg bg-amber-700 px-4 text-sm font-bold text-white disabled:opacity-60">{busyId === resettingAccount.id ? "Saving…" : "Replace password"}</button></div></form> : null}

      {initialAccounts.length ? <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Staff member</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Last sign in</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th></tr></thead><tbody>{initialAccounts.map((account) => <tr key={account.id} className="border-t border-slate-100"><td className="px-4 py-3"><p className="font-semibold text-slate-900">{account.displayName}</p><p className="text-xs text-slate-500">{account.username}</p></td><td className="px-4 py-3 text-slate-600">{account.role === "warehouse_manager" ? "Warehouse manager" : "Warehouse staff"}</td><td className="px-4 py-3 text-slate-600">{account.lastLoginAt ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(account.lastLoginAt)) : "Never"}</td><td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${account.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>{account.active ? "Active" : "Disabled"}</span></td><td className="px-4 py-3"><div className="flex justify-end gap-2"><button type="button" onClick={() => { setResettingAccount(account); setError(null); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">Reset password</button><button type="button" disabled={busyId === account.id} onClick={() => toggleAccount(account)} className={`rounded-lg border px-3 py-2 text-xs font-bold disabled:opacity-60 ${account.active ? "border-rose-200 text-rose-700 hover:bg-rose-50" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}>{busyId === account.id ? "Updating…" : account.active ? "Disable" : "Enable"}</button></div></td></tr>)}</tbody></table></div> : <div className="rounded-xl border border-dashed border-slate-300 px-5 py-8 text-center"><p className="font-semibold text-slate-800">No warehouse accounts yet</p><p className="mt-1 text-sm text-slate-500">Create the first login when the warehouse team is ready.</p></div>}
    </div>
  </section>;
}
