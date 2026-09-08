"use client";

import { usePathname } from "next/navigation";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import type { AuthenticatedUser } from "@/types/auth";

export function AppShell({ children, user }: { children: React.ReactNode; user: AuthenticatedUser | null }) {
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/forgot-password") return children;
  return <div className="min-h-screen bg-[#f5f7f6]"><div className="flex"><Sidebar role={user?.role}/><div className="min-w-0 flex-1"><Header user={user}/><main className="mx-auto max-w-[1500px] p-5 md:p-8">{children}</main></div></div></div>;
}
