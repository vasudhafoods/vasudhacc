import Image from "next/image";
import Link from "next/link";

export default function ForgotPasswordPage() {
  return <main className="grid min-h-screen place-items-center bg-background px-5 py-10">
    <section className="w-full max-w-md rounded-2xl border border-[#f3e7d3] bg-white p-7 shadow-[0_18px_50px_rgba(90,61,43,.08)]">
      <div className="flex items-center gap-3"><Image src="/icon.svg" alt="" width={44} height={44} className="size-11 rounded-full"/><div><p className="text-lg font-semibold tracking-tight text-[#5a3d2b]">Vasudha Foods</p><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#315b32]">Command Center</p></div></div>
      <h1 className="mt-7 text-2xl font-semibold tracking-tight text-[#5a3d2b]">Reset your password</h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">Warehouse and retail-sales accounts are managed by the Vasudha administrator. Ask an administrator to reset or replace your temporary password.</p>
      <ol className="mt-5 space-y-3 text-sm text-slate-600">
        <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700">1</span><span>Contact the Vasudha Command Center administrator.</span></li>
        <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700">2</span><span>Ask them to issue a new staff password for your username.</span></li>
        <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700">3</span><span>Return to this page and sign in with the replacement password.</span></li>
      </ol>
      <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">Never send your current password through email or chat. Administrators can create a replacement without seeing the old password.</div>
      <Link href="/login" className="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-[#315b32] text-sm font-semibold text-white transition hover:bg-[#244527]">Back to sign in</Link>
    </section>
  </main>;
}
