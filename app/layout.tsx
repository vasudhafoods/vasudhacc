import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";
import { getDashboardSession } from "@/lib/auth/authorization";

export const metadata: Metadata = {
  title: "Vasudha Commerce Command Center",
  description: "Internal ecommerce inventory intelligence for Vasudha Foods",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getDashboardSession();
  const user = session ? { userId: session.userId, username: session.username, displayName: session.displayName, role: session.role } : null;
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full"><AppShell user={user}>{children}</AppShell></body>
    </html>
  );
}
