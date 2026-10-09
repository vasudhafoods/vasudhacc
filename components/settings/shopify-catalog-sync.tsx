"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CatalogSyncResult } from "@/services/catalog-sync";
import type { WarehouseFoundationStatus } from "@/services/warehouse-foundation";

interface InventoryUpdateResult {
  examined: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

interface WebhookSubscriptionResult {
  created: string[];
  existing: string[];
}

export function ShopifyCatalogSync({ initialStatus }: { initialStatus: WarehouseFoundationStatus }) {
  const router = useRouter();
  const [automation, setAutomation] = useState<{ subscriptionsCheckedAt?: string; lastEventAt?: string; checkedThrough?: string; error?: string; failed?: number } | null>(null);
  useEffect(() => {
    let active = true;
    const read = async () => { try { const response = await fetch("/api/shopify/automation"); if (response.ok && active) setAutomation(await response.json()); } catch { /* Next automatic check retries. */ } };
    void read(); const timer = window.setInterval(read, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<CatalogSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!flash) return;
    const timeout = window.setTimeout(() => setFlash(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [flash]);

  async function syncCatalog() {
    setSyncing(true);
    setError(null);
    setFlash(null);
    try {
      const response = await fetch("/api/operations/catalog/sync", { method: "POST" });
      const body = await response.json() as { result?: CatalogSyncResult; inventoryUpdates?: InventoryUpdateResult; webhooks?: WebhookSubscriptionResult; error?: { message?: string } };
      if (!response.ok || !body.result) throw new Error(body.error?.message ?? "Shopify catalog could not be synchronized.");
      setResult(body.result);
      const inventoryMessage = body.inventoryUpdates?.examined
        ? ` ${body.inventoryUpdates.succeeded} queued stock update${body.inventoryUpdates.succeeded === 1 ? "" : "s"} delivered${body.inventoryUpdates.failed ? `; ${body.inventoryUpdates.failed} will retry automatically` : ""}.`
        : " No queued stock updates were waiting.";
      const webhookMessage = body.webhooks
        ? ` Shopify order automation ready (${body.webhooks.created.length} new, ${body.webhooks.existing.length} already connected).`
        : "";
      setFlash(`Sync completed — ${body.result.distinctSkus} SKUs, ${body.result.pricedRows} Shopify prices, and ${body.result.mappedRows} inventory rows synchronized.${inventoryMessage}${webhookMessage}`);
      router.refresh();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Shopify catalog could not be synchronized.");
    } finally {
      setSyncing(false);
    }
  }

  const ready = initialStatus.configured && initialStatus.initialized;
  return <>
    {flash ? <div className="fixed right-4 top-4 z-[100] flex w-[calc(100%-2rem)] max-w-md items-start gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-950 shadow-[0_16px_50px_rgba(15,23,42,.18)]" role="status" aria-live="polite">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-emerald-600 text-sm font-bold text-white">✓</span>
      <div className="min-w-0 flex-1"><p className="text-sm font-bold">Shopify sync completed</p><p className="mt-1 text-xs leading-5 text-emerald-800">{flash}</p></div>
      <button type="button" onClick={() => setFlash(null)} className="px-1 text-lg leading-none text-emerald-700" aria-label="Dismiss sync message">×</button>
    </div> : null}
    <section className="rounded-xl border border-slate-200 bg-white p-5">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[.12em] text-emerald-700">Shopify integration</p>
        <h2 className="mt-1 text-sm font-semibold text-slate-900">Automatic Shopify synchronization</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">Shopify orders automatically deduct packet stock when received; fulfillment does not deduct it again. Cancellations restore unfulfilled stock, and returned packets go to QC. Webhooks work even when this dashboard is closed. While it is open, recovery checks and stock refreshes run every minute; the daily job is a backup. No manual order sync is required.</p>
      </div>
      <button onClick={syncCatalog} disabled={!ready || syncing} className="shrink-0 rounded-lg bg-brand-primary px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{syncing ? "Synchronizing…" : "Refresh product catalog"}</button>
    </div>
    <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
      <p className="font-semibold">{automation?.error ? (automation.error.includes("Database migration required") ? "Database migration required" : "Automatic sync needs attention") : automation?.subscriptionsCheckedAt ? "Live order webhooks connected" : "Checking automatic order connection…"}</p>
      {automation?.subscriptionsCheckedAt ? <p className="mt-1">Connection last verified: {new Date(automation.subscriptionsCheckedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p> : null}
      <p className="mt-1">Last processed event: {automation?.lastEventAt ? new Date(automation.lastEventAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "No event processed yet"}</p>
      {automation?.error ? <p role="alert" className="mt-2 text-red-700">{automation.error}</p> : null}
    </div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Status label="Database" value={initialStatus.initialized ? "Ready" : initialStatus.configured ? "Migration required" : "Not configured"}/>
      <Status label="Products in Neon" value={String(initialStatus.products)}/>
      <Status label="Mapped rows" value={String(initialStatus.mappings)}/>
      <Status label="Pending Shopify writes" value={String(initialStatus.pendingShopifyUpdates)}/>
      <Status label="Failed Shopify events" value={String(initialStatus.failedShopifyWebhooks)}/>
    </div>
    {result ? <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900"><p className="font-semibold">Catalog synchronized successfully.</p><p className="mt-1">{result.distinctSkus} SKUs · {result.pricedRows} Shopify prices · {result.mappedRows} mapped rows · {result.conflictedRows} conflicted rows · {result.skippedMissingSku} missing-SKU rows skipped</p></div> : null}
    {error ? <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"><p className="font-semibold">Synchronization failed</p><p className="mt-1">{error}</p></div> : null}
    {!ready ? <p className="mt-4 text-xs text-amber-700">Database migration must be complete before catalog synchronization.</p> : null}
    </section>
  </>;
}

function Status({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold text-slate-800">{value}</p></div>;
}
