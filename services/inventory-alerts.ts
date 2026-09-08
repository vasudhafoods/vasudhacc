import "server-only";
import { readOperationsSettings } from "@/services/operations-store";
import type { CurrentInventoryResult } from "@/types/shopify";
import type { AlertDeliveryResult } from "@/types/operations";

function buildSummary(inventory: CurrentInventoryResult, defaultThreshold: number, thresholds: Record<string, number>) {
  const attention = inventory.items.filter((item) => item.available <= (thresholds[item.productId] ?? defaultThreshold));
  const out = attention.filter((item) => item.available <= 0).length;
  const low = attention.length - out;
  const details = attention.slice(0, 15).map((item) => `${item.productTitle} / ${item.variantTitle} (${item.locationName}): ${item.available}`).join("\n");
  return { subject: `Vasudha inventory summary: ${out} out, ${low} low`, text: `Inventory: ${inventory.summary.totalInventory}\nProducts: ${inventory.summary.totalProducts}\nOut of stock rows: ${out}\nLow stock rows: ${low}${details ? `\n\nAttention:\n${details}` : ""}` };
}

function kolkataDateKey(value: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : value.slice(0, 10);
}

async function sendEmail(subject: string, text: string, capturedAt: string): Promise<AlertDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.ALERT_EMAIL_FROM?.trim();
  const to = process.env.ALERT_EMAIL_TO?.split(",").map((value) => value.trim()).filter(Boolean);
  if (!apiKey || !from || !to?.length) return { channel: "email", status: "skipped", message: "Email credentials are not configured." };
  try {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `vasudha-inventory-summary-${kolkataDateKey(capturedAt)}` }, body: JSON.stringify({ from, to, subject, text }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { channel: "email", status: "failed", message: `Email provider returned HTTP ${response.status}.` };
    return { channel: "email", status: "sent", message: "Daily summary email sent." };
  } catch { return { channel: "email", status: "failed", message: "Email provider could not be reached." }; }
}

async function sendWhatsApp(summary: string): Promise<AlertDeliveryResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const to = process.env.ALERT_WHATSAPP_TO?.trim();
  const template = process.env.WHATSAPP_TEMPLATE_NAME?.trim();
  const version = process.env.WHATSAPP_API_VERSION?.trim() || "v23.0";
  if (!token || !phoneId || !to || !template) return { channel: "whatsapp", status: "skipped", message: "WhatsApp template credentials are not configured." };
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: template, language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: summary.slice(0, 900) }] }] } }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { channel: "whatsapp", status: "failed", message: `WhatsApp provider returned HTTP ${response.status}.` };
    return { channel: "whatsapp", status: "sent", message: "Daily WhatsApp summary sent." };
  } catch { return { channel: "whatsapp", status: "failed", message: "WhatsApp provider could not be reached." }; }
}

export async function deliverInventorySummary(inventory: CurrentInventoryResult): Promise<AlertDeliveryResult[]> {
  const settings = await readOperationsSettings();
  const summary = buildSummary(inventory, settings.defaultLowStockThreshold, settings.productThresholds);
  const results: AlertDeliveryResult[] = [];
  if (settings.alerts.emailEnabled) results.push(await sendEmail(summary.subject, summary.text, inventory.capturedAt));
  if (settings.alerts.whatsappEnabled) results.push(await sendWhatsApp(`${summary.subject}. ${summary.text}`));
  return results;
}
