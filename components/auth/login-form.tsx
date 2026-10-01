"use client";

import Link from "next/link";
import { useState } from "react";

export function LoginForm({ initialPortal = "admin" }: { initialPortal?: "admin" | "warehouse" | "sales" }) {
  const [showPassword, setShowPassword] = useState(false);
  const [portal, setPortal] = useState(initialPortal);
  const usernameId = "login-username";
  const passwordId = "login-password";
  const workspaceName = portal === "admin" ? "Admin" : portal === "warehouse" ? "Warehouse" : "Sales";

  return <form action="/api/auth/login" method="post" className="mt-6 space-y-4">
    <div>
      <label htmlFor="login-portal" className="text-xs font-semibold text-slate-700">I am</label>
      <select id="login-portal" name="portal" value={portal} onChange={event => setPortal(event.target.value as typeof portal)} className="mt-2 h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 outline-none transition focus:border-emerald-700 focus:bg-white focus:ring-4 focus:ring-emerald-100">
        <option value="admin">Admin</option><option value="warehouse">Warehouse</option><option value="sales">Sales</option>
      </select>
    </div>
    <div>
      <label htmlFor={usernameId} className="text-xs font-semibold text-slate-700">Username</label>
        <input id={usernameId} name="username" autoComplete="username" required maxLength={200} placeholder="Enter your username" className="mt-2 h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 outline-none transition focus:border-emerald-700 focus:bg-white focus:ring-4 focus:ring-emerald-100"/>
    </div>
    <div>
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={passwordId} className="text-xs font-semibold text-slate-700">Password</label>
        <Link href={`/forgot-password?portal=${portal}`} className="text-xs font-semibold text-[#246552] hover:underline">Forgot password?</Link>
      </div>
      <div className="relative mt-2">
        <input id={passwordId} name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required maxLength={500} placeholder="Enter password" className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 pr-16 text-sm text-slate-900 outline-none transition focus:border-emerald-700 focus:bg-white focus:ring-4 focus:ring-emerald-100"/>
        <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-controls={passwordId} aria-pressed={showPassword} className="absolute inset-y-0 right-0 px-3 text-xs font-semibold text-slate-500 hover:text-slate-800">{showPassword ? "Hide" : "Show"}</button>
      </div>
    </div>
    <button type="submit" className="h-12 w-full rounded-xl bg-[#174f40] text-sm font-bold text-white shadow-sm transition hover:bg-[#123f34]">Sign in to {workspaceName}</button>
  </form>;
}
