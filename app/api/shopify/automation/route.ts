import { after } from "next/server";
import { getDashboardSession } from "@/lib/auth/authorization";
import { maintainShopifyAutomation, readShopifyAutomationStatus } from "@/services/shopify-automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  if (!await getDashboardSession()) return Response.json({ error: "Authentication required." }, { status: 401 });
  return Response.json(await readShopifyAutomationStatus(), { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  if (!await getDashboardSession()) return Response.json({ error: "Authentication required." }, { status: 401 });
  after(async () => {
    try { await maintainShopifyAutomation(request.url); }
    catch { console.error("Automatic Shopify maintenance failed; scheduled retry will follow."); }
  });
  return Response.json({ scheduled: true }, { status: 202 });
}
