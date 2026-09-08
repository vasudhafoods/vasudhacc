"use client";

import Link from "next/link";
import { useState } from "react";

export function LoginForm() {
  const [showPassword, setShowPassword] = useState(false);

  return <form action="/api/auth/login" method="post" className="mt-6 space-y-4">
    <div>
      <label htmlFor="username" className="text-xs font-semibold text-slate-700">Username</label>
      <input id="username" name="username" autoComplete="username" required maxLength={200} className="mt-2 h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-emerald-700"/>
    </div>
    <div>
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="password" className="text-xs font-semibold text-slate-700">Password</label>
        <Link href="/forgot-password" className="text-xs font-semibold text-[#246552] hover:underline">Forgot password?</Link>
      </div>
      <div className="relative mt-2">
        <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required maxLength={500} className="h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 pr-16 text-sm text-slate-900 outline-none focus:border-emerald-700"/>
        <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-controls="password" aria-pressed={showPassword} className="absolute inset-y-0 right-0 px-3 text-xs font-semibold text-slate-500 hover:text-slate-800">{showPassword ? "Hide" : "Show"}</button>
      </div>
    </div>
    <button type="submit" className="h-11 w-full rounded-lg bg-[#174f40] text-sm font-semibold text-white transition hover:bg-[#123f34]">Sign in securely</button>
  </form>;
}
