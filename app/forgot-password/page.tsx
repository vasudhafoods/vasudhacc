import Link from "next/link";

export default function ForgotPasswordPage() {
  return <main className="grid min-h-screen place-items-center bg-[#f5f7f6] px-5 py-10">
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-[0_18px_50px_rgba(15,23,42,.08)]">
      <div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-xl bg-[#163f35] text-base font-semibold text-white">V</div><div><p className="text-lg font-semibold tracking-tight text-slate-900">Vasudha Foods</p><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-slate-400">Command Center</p></div></div>
      <h1 className="mt-7 text-2xl font-semibold tracking-tight text-slate-900">Reset dashboard password</h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">This dashboard uses administrator-managed credentials. Passwords are not stored in the application database, so an authorized Vercel administrator must reset the password.</p>
      <ol className="mt-5 space-y-3 text-sm text-slate-600">
        <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700">1</span><span>Open the Vasudha Command Center project in Vercel.</span></li>
        <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700">2</span><span>Update <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">DASHBOARD_PASSWORD</code> with a new password of at least 12 characters.</span></li>
        <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700">3</span><span>Redeploy the latest Production deployment, then return to sign in.</span></li>
      </ol>
      <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">If you do not administer the Vercel project, contact the Vasudha system administrator. Never send the password through email or chat.</div>
      <Link href="/login" className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-[#174f40] text-sm font-semibold text-white transition hover:bg-[#123f34]">Back to sign in</Link>
    </section>
  </main>;
}
