import { LoginForm } from "@/components/auth/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; portal?: string }> }) {
  const { error, portal } = await searchParams;
  const message = error === "configuration"
    ? "Dashboard authentication is not configured. Add the required environment variables."
    : error === "credentials"
      ? "The username or password is incorrect."
      : error === "access"
        ? "This account does not have access to that workspace."
      : null;

  return <main className="min-h-screen bg-[#f5f7f6] px-5 py-10 sm:py-14">
    <div className="mx-auto w-full max-w-5xl">
      <header className="text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-[#163f35] text-lg font-bold text-white shadow-sm">V</div>
        <p className="mt-3 text-xl font-bold tracking-tight text-slate-900">Vasudha Foods</p>
        <p className="mt-1 text-[10px] font-semibold uppercase tracking-[.18em] text-slate-400">Command Center</p>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Choose your login</h1>
        <p className="mt-2 text-sm text-slate-500">Management, warehouse, and retail-sales teams have role-restricted workspaces.</p>
      </header>

      {message ? <div className="mx-auto mt-6 max-w-2xl rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-center text-sm font-medium text-rose-800" role="alert">{message}</div> : null}

      <div className="mt-7 grid overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_18px_55px_rgba(15,23,42,.08)] md:grid-cols-2">
        <section className={`p-6 sm:p-8 ${portal === "admin" && error ? "bg-rose-50/20" : ""}`} aria-labelledby="admin-login-title">
          <div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-xl bg-[#174f40] text-sm font-bold text-white">A</div><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Management</p><h2 id="admin-login-title" className="text-xl font-bold text-slate-950">Admin Login</h2></div></div>
          <p className="mt-4 min-h-10 text-sm leading-6 text-slate-500">Full access to dashboards, Shopify inventory, stock planning, reports, settings, and staff accounts.</p>
          <LoginForm portal="admin"/>
        </section>

        <section className={`border-t border-slate-200 bg-slate-50/70 p-6 sm:p-8 md:border-l md:border-t-0 ${portal === "warehouse" && error ? "bg-rose-50/30" : ""}`} aria-labelledby="warehouse-login-title">
          <div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-xl bg-[#dcece5] text-sm font-bold text-[#174f40]">O</div><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">Operations</p><h2 id="warehouse-login-title" className="text-xl font-bold text-slate-950">Warehouse & Sales Login</h2></div></div>
          <p className="mt-4 min-h-10 text-sm leading-6 text-slate-500">Warehouse users manage stock. Retail Sales users can enter offline sales, collections, and pending payment updates.</p>
          <LoginForm portal="warehouse"/>
        </section>
      </div>
      <p className="mt-5 text-center text-[11px] text-slate-400">Secure sessions expire automatically after 12 hours.</p>
    </div>
  </main>;
}
