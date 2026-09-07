"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CatalogSyncResult } from "@/services/catalog-sync";
import type { WarehouseFoundationStatus } from "@/services/warehouse-foundation";

export function ShopifyCatalogSync({ initialStatus }: { initialStatus: WarehouseFoundationStatus }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<CatalogSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function syncCatalog() {
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch("/api/operations/catalog/sync", { method: "POST" });
      const body = await response.json() as { result?: CatalogSyncResult; error?: { message?: string } };
      if (!response.ok || !body.result) throw new Error(body.error?.message ?? "Shopify catalog could not be synchronized.");
      setResult(body.result);
      router.refresh();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Shopify catalog could not be synchronized.");
    } finally {
      setSyncing(false);
    }
  }

  const ready = initialStatus.configured && initialStatus.initialized;
  return <section className="rounded-xl border border-slate-200 bg-white p-5">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[.12em] text-[#2d725f]">Shopify integration</p>
        <h2 className="mt-1 text-sm font-semibold text-slate-900">SKU catalog synchronization</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">Imports Shopify product, variant, inventory-item and location IDs into Neon using SKU as the shared business identity. Credentials remain server-side in Vercel.</p>
      </div>
      <button onClick={syncCatalog} disabled={!ready || syncing} className="shrink-0 rounded-lg bg-[#164c3d] px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{syncing ? "Synchronizing…" : "Sync Shopify SKUs"}</button>
    </div>
    <div className="mt-5 grid gap-3 sm:grid-cols-4">
      <Status label="Database" value={initialStatus.initialized ? "Ready" : initialStatus.configured ? "Migration required" : "Not configured"}/>
      <Status label="Products in Neon" value={String(initialStatus.products)}/>
      <Status label="Mapped rows" value={String(initialStatus.mappings)}/>
      <Status label="Pending Shopify writes" value={String(initialStatus.pendingShopifyUpdates)}/>
    </div>
    {result ? <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900"><p className="font-semibold">Catalog synchronized successfully.</p><p className="mt-1">{result.distinctSkus} SKUs · {result.mappedRows} mapped rows · {result.conflictedRows} conflicted rows · {result.skippedMissingSku} missing-SKU rows skipped</p></div> : null}
    {error ? <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"><p className="font-semibold">Synchronization failed</p><p className="mt-1">{error}</p></div> : null}
    {!ready ? <p className="mt-4 text-xs text-amber-700">Database migration must be complete before catalog synchronization.</p> : null}
  </section>;
}

function Status({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold text-slate-800">{value}</p></div>;
}
