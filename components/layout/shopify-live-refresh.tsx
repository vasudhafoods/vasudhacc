"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function ShopifyLiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/shopify/automation", { method: "POST" }).catch(() => undefined);
      // Refresh server stock data without resetting an open form's client state.
      router.refresh();
    };
    const initial = window.setTimeout(check, 1000);
    const timer = window.setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [router]);
  return null;
}
