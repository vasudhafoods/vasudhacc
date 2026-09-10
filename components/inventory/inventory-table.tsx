"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { filterInventoryItems } from "@/lib/inventory/filter";
import type { InventoryFeed } from "@/lib/inventory/live-data";
import type { InventoryComparison, InventoryStatus, ProductPhysicalStock } from "@/types/inventory";
import { ExportControls } from "./export-controls";
import { StatusBadge } from "./status-badge";

type SortKey = "productTitle" | "actual";
type ProductStatus = "all" | "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
const PAGE_SIZE = 10;

interface ProductGroup {
  productId: string;
  productTitle: string;
  imageUrl: string | null;
  productStatus: InventoryComparison["productStatus"];
  variants: InventoryComparison[];
  physical: ProductPhysicalStock | null;
  status: InventoryStatus;
}

function productStatusRank(status: InventoryComparison["productStatus"]): number {
  if (status === "ACTIVE") return 0;
  if (status === "DRAFT") return 2;
  return 1;
}

const stockStatusRank: Record<InventoryStatus, number> = {
  "out-of-stock": 0,
  "low-stock": 1,
  "stock-reduced": 2,
  "stock-increased": 3,
  "in-stock": 4,
};

function groupProducts(items: InventoryComparison[], physicalStock: Record<string, ProductPhysicalStock>): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const item of items) {
    const current = groups.get(item.productId);
    if (current) {
      current.variants.push(item);
      if (stockStatusRank[item.status] < stockStatusRank[current.status]) current.status = item.status;
      continue;
    }
    groups.set(item.productId, {
      productId: item.productId,
      productTitle: item.productTitle,
      imageUrl: item.imageUrl,
      productStatus: item.productStatus,
      variants: [item],
      physical: physicalStock[item.productId] ?? null,
      status: item.status,
    });
  }
  return [...groups.values()];
}

function StockValue({ stock, bucket }: { stock: ProductPhysicalStock | null; bucket: "actual" | "online" | "retail" | "buffer" }) {
  if (!stock?.recorded) return <span className="text-slate-300">—</span>;
  return <span>{stock[bucket]}</span>;
}

export function InventoryTable({ items, feed, physicalStock, hideUntrackedByDefault = false }: {
  items: InventoryComparison[];
  feed: InventoryFeed;
  physicalStock: Record<string, ProductPhysicalStock>;
  hideUntrackedByDefault?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | InventoryStatus>("all");
  const [location, setLocation] = useState("all");
  const [productStatus, setProductStatus] = useState<ProductStatus>("all");
  const [tracked, setTracked] = useState<"all" | "tracked" | "untracked">(hideUntrackedByDefault ? "tracked" : "all");
  const [sort, setSort] = useState<SortKey>("productTitle");
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(1);
  const locations = [...new Set(items.map((item) => item.locationName))];
  const filtered = useMemo(() => {
    const variants = filterInventoryItems(items, { query, status, location, productStatus, tracked });
    return groupProducts(variants, physicalStock).sort((left, right) => {
      const lifecycleOrder = productStatusRank(left.productStatus) - productStatusRank(right.productStatus);
      if (lifecycleOrder !== 0) return lifecycleOrder;
      const result = sort === "productTitle"
        ? left.productTitle.localeCompare(right.productTitle)
        : (left.physical?.recorded ? left.physical.actual : -1) - (right.physical?.recorded ? right.physical.actual : -1);
      return descending ? -result : result;
    });
  }, [items, physicalStock, query, status, location, productStatus, tracked, sort, descending]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function updateSort(key: SortKey) {
    if (sort === key) setDescending((value) => !value);
    else { setSort(key); setDescending(false); }
  }
  function resetPage() { setPage(1); }

  return <div className="rounded-xl border border-slate-200/80 bg-white">
    <div className="flex flex-col gap-3 border-b border-slate-100 p-4 xl:flex-row xl:items-start xl:justify-between">
      <div className="flex min-w-0 flex-1 flex-wrap gap-3">
        <div className="relative min-w-[220px] flex-1"><Icon name="search" className="absolute left-3 top-2.5 size-4 text-slate-400"/><input value={query} onChange={(event) => { setQuery(event.target.value); resetPage(); }} className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-xs outline-none focus:border-emerald-700" placeholder="Search product, pack option or SKU..."/></div>
        <select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); resetPage(); }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600"><option value="all">All stock statuses</option><option value="in-stock">In stock</option><option value="low-stock">Low stock</option><option value="out-of-stock">Out of stock</option><option value="stock-increased">Stock increased</option><option value="stock-reduced">Stock reduced</option></select>
        <select value={productStatus} onChange={(event) => { setProductStatus(event.target.value as ProductStatus); resetPage(); }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600"><option value="all">Active first · drafts last</option><option value="ACTIVE">Active</option><option value="DRAFT">Draft</option><option value="ARCHIVED">Archived</option><option value="UNLISTED">Unlisted</option></select>
        <select value={tracked} onChange={(event) => { setTracked(event.target.value as typeof tracked); resetPage(); }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600"><option value="all">All variants</option><option value="tracked">Tracked only</option><option value="untracked">Untracked only</option></select>
        <select value={location} onChange={(event) => { setLocation(event.target.value); resetPage(); }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600"><option value="all">All Shopify locations</option>{locations.map((value) => <option key={value}>{value}</option>)}</select>
      </div>
      <ExportControls feed={feed} query={query} status={status} location={location} productStatus={productStatus} tracked={tracked}/>
    </div>
    <div className="border-b border-emerald-100 bg-emerald-50/60 px-5 py-3 text-xs leading-5 text-emerald-900"><strong>Actual stock</strong> is the physical individual-packet balance in Neon. Pack-option quantities are shown separately inside each product so bundles are not added together as physical stock.</div>
    <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left"><thead><tr className="border-b border-slate-100 bg-slate-50/70 text-[10px] uppercase tracking-wide text-slate-400"><th className="px-5 py-3 font-semibold"><button onClick={() => updateSort("productTitle")}>Product</button></th><th className="px-3 py-3 text-right font-semibold"><button onClick={() => updateSort("actual")}>Actual packets</button></th><th className="px-3 py-3 text-right font-semibold">Online</th><th className="px-3 py-3 text-right font-semibold">Retail</th><th className="px-3 py-3 text-right font-semibold">Buffer</th><th className="px-3 py-3 font-semibold">Shopify pack options</th><th className="px-3 py-3 font-semibold">Listing health</th><th className="px-4 py-3"/></tr></thead>
      <tbody className="divide-y divide-slate-100">{visible.map((product) => {
        const variantCount = new Set(product.variants.map((variant) => variant.variantId)).size;
        const locationCount = new Set(product.variants.map((variant) => variant.locationId)).size;
        return <tr key={product.productId} className="text-xs text-slate-600 hover:bg-slate-50/70">
          <td className="px-5 py-3.5"><div className="flex items-center gap-3">{product.imageUrl ? <Image src={product.imageUrl} alt="" width={40} height={40} className="size-10 shrink-0 rounded-lg object-cover"/> : <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#f2eee3] font-semibold text-[#8f7c45]">{product.productTitle.charAt(0)}</div>}<span className="max-w-[280px] font-semibold text-slate-800">{product.productTitle}<small className="mt-1 block font-normal capitalize text-slate-400">{(product.productStatus ?? "unknown").toLowerCase()}</small></span></div></td>
          <td className="px-3 py-3.5 text-right text-lg font-bold tabular-nums text-slate-950"><StockValue stock={product.physical} bucket="actual"/><span className="mt-0.5 block text-[9px] font-normal uppercase tracking-wide text-slate-400">Individual packets</span></td>
          <td className="px-3 py-3.5 text-right font-bold tabular-nums text-emerald-700"><StockValue stock={product.physical} bucket="online"/></td>
          <td className="px-3 py-3.5 text-right font-bold tabular-nums text-blue-700"><StockValue stock={product.physical} bucket="retail"/></td>
          <td className="px-3 py-3.5 text-right font-bold tabular-nums text-amber-700"><StockValue stock={product.physical} bucket="buffer"/></td>
          <td className="px-3 py-3.5"><p className="font-semibold text-slate-800">{variantCount} pack option{variantCount === 1 ? "" : "s"}</p><p className="mt-1 text-[10px] text-slate-400">Across {locationCount} Shopify location{locationCount === 1 ? "" : "s"} · Click for details</p></td>
          <td className="px-3 py-3.5"><StatusBadge status={product.status}/></td>
          <td className="px-4 py-3.5"><Link href={`/inventory/${encodeURIComponent(product.productId)}`} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 font-bold text-emerald-700" aria-label={`View ${product.productTitle} pack options`}>View <Icon name="chevron" className="size-4"/></Link></td>
        </tr>;
      })}</tbody></table></div>
    {visible.length === 0 ? <div className="grid min-h-56 place-items-center text-center"><div><div className="mx-auto grid size-11 place-items-center rounded-full bg-slate-100"><Icon name="search" className="size-5 text-slate-400"/></div><p className="mt-3 text-sm font-semibold text-slate-700">No inventory found</p><p className="mt-1 text-xs text-slate-400">Try changing your search or filters.</p></div></div> : <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4"><p className="text-[11px] text-slate-400">Showing products {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}</p><div className="flex gap-2"><button disabled={page === 1} onClick={() => setPage((current) => current - 1)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs disabled:opacity-40">Previous</button><button disabled={page === pages} onClick={() => setPage((current) => current + 1)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs disabled:opacity-40">Next</button></div></div>}
  </div>;
}
