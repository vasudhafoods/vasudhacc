import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { products } from "@/db/schema";
import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { extractInvoice, InvoiceExtractError } from "@/services/invoice-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SALES_ACCESS = ["admin", "management", "retail_sales"] as const;

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, SALES_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot record offline sales." } }, { status: 403 });

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new InvoiceExtractError("Attach the invoice file.");
    const catalog = await getDatabase().select({ id: products.id, sku: products.sku, name: products.name }).from(products).where(eq(products.active, true)).orderBy(products.name);
    const invoice = await extractInvoice(file, catalog);
    return Response.json({ ok: true, invoice }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InvoiceExtractError) return Response.json({ error: { code: "INVOICE_READ_FAILED", message: error.message } }, { status: error.status });
    console.error("Invoice extraction failed", error);
    return Response.json({ error: { code: "INVOICE_READ_FAILED", message: "The invoice could not be read. Enter the details manually." } }, { status: 502 });
  }
}
