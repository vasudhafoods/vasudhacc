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
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Sign in to Vasudha</h1>
        <p className="mt-2 text-sm text-slate-500">Choose your role. You can only access the workspace assigned to your account.</p>
      </header>

      {message ? <div className="mx-auto mt-6 max-w-2xl rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-center text-sm font-medium text-rose-800" role="alert">{message}</div> : null}

      <section className={`mx-auto mt-9 w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_18px_50px_rgba(15,23,42,.08)] sm:p-8 ${error ? "ring-2 ring-rose-100" : ""}`} aria-label="Sign in form">
        <LoginForm initialPortal={portal === "warehouse" || portal === "sales" ? portal : "admin"}/>
      </section>
      <p className="mt-5 text-center text-[11px] text-slate-400">Secure sessions expire automatically after 12 hours.</p>
    </div>
  </main>;
}
