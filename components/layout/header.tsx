"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Sidebar } from "./sidebar";
import { isWarehouseRole, roleLabel, type AuthenticatedUser } from "@/types/auth";

export function Header({ user }: { user: AuthenticatedUser | null }) {
  const [open, setOpen] = useState(false);
  const warehouseOnly = user ? isWarehouseRole(user.role) : false;
  const initials = user?.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "VA";
  return <>
    <header className="sticky top-0 z-30 flex h-20 items-center border-b border-slate-200 bg-white/95 px-5 backdrop-blur md:px-8">
      <button className="mr-3 rounded-lg p-2 text-slate-600 lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation"><Icon name="menu" className="size-5"/></button>
      {!warehouseOnly ? <div className="relative hidden w-full max-w-sm md:block"><Icon name="search" className="absolute left-3 top-2.5 size-4 text-slate-400"/><input className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-emerald-700" placeholder="Search command center..." aria-label="Search command center"/></div> : <p className="hidden text-sm font-semibold text-[#174f40] sm:block">Warehouse stock entry</p>}
      <div className="ml-auto flex items-center gap-4">{!warehouseOnly ? <><button className="relative rounded-full p-2 text-slate-500" aria-label="Notifications"><Icon name="bell" className="size-5"/><span className="absolute right-2 top-1.5 size-1.5 rounded-full bg-red-500"/></button><div className="h-8 w-px bg-slate-200"/></> : null}<div className="flex items-center gap-3"><div className="hidden text-right sm:block"><p className="text-xs font-semibold text-slate-800">{user?.displayName ?? "Vasudha Admin"}</p><p className="text-[10px] text-slate-400">{user ? roleLabel(user.role) : "Command Center"}</p></div><div className="grid size-9 place-items-center rounded-full bg-[#dcece5] text-xs font-bold text-[#164c3d]">{initials}</div><form action="/api/auth/logout" method="post"><button type="submit" className="rounded-md border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-50">Sign out</button></form></div></div>
    </header>
    {open && <div className="fixed inset-0 z-50 lg:hidden"><button className="absolute inset-0 bg-slate-950/30" onClick={() => setOpen(false)} aria-label="Close navigation"/><div className="relative h-full w-[260px] bg-white shadow-2xl"><Sidebar mobile role={user?.role}/><button className="absolute right-3 top-4 p-2 text-slate-500" onClick={() => setOpen(false)} aria-label="Close navigation">×</button></div></div>}
  </>;
}
