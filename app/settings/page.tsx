import { connection } from "next/server";
import { requireDashboardSession } from "@/lib/auth/authorization";
import { getInventoryFeed } from "@/lib/inventory/live-data";
import { readOperationsSettings } from "@/services/operations-store";
import { OperationsSettingsForm } from "@/components/settings/operations-settings-form";
import { ShopifyCatalogSync } from "@/components/settings/shopify-catalog-sync";
import { getWarehouseFoundationStatus } from "@/services/warehouse-foundation";

export default async function SettingsPage(){await requireDashboardSession();await connection();const [settings,feed,database]=await Promise.all([readOperationsSettings(),getInventoryFeed(),getWarehouseFoundationStatus()]);const products=[...new Map(feed.items.map((item)=>[item.productId,{id:item.productId,title:item.productTitle}])).values()].sort((a,b)=>a.title.localeCompare(b.title));return <div className="space-y-6"><div><p className="text-xs font-medium text-[#2d725f]">Configuration</p><h1 className="mt-1 text-2xl font-semibold text-slate-900">Inventory settings</h1><p className="mt-1 text-sm text-slate-500">Thresholds, reorder assumptions, integrations, and notification channels.</p></div><ShopifyCatalogSync initialStatus={database}/><OperationsSettingsForm initial={settings} products={products}/></div>}
