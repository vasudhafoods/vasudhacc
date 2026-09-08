import { LoginForm } from "@/components/auth/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error === "configuration"
    ? "Dashboard authentication is not configured. Add the required environment variables."
    : error === "credentials"
      ? "The username or password is incorrect."
      : error === "access"
        ? "This account does not have access to that workspace."
      : null;

  return <main className="grid min-h-screen place-items-center bg-[#f5f7f6] px-5 py-10">
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-[0_18px_50px_rgba(15,23,42,.08)]">
      <div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-xl bg-[#163f35] text-base font-semibold text-white">V</div><div><p className="text-lg font-semibold tracking-tight text-slate-900">Vasudha Foods</p><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-slate-400">Command Center</p></div></div>
      <div className="mt-7"><h1 className="text-2xl font-semibold tracking-tight text-slate-900">Team sign in</h1><p className="mt-2 text-sm text-slate-500">Sign in with your administrator or warehouse account.</p></div>
      {message ? <div className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{message}</div> : null}
      <LoginForm/>
      <p className="mt-5 text-center text-[11px] text-slate-400">Sessions expire automatically after 12 hours.</p>
    </section>
  </main>;
}
