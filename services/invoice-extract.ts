import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const INVOICE_MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const InvoiceSchema = z.object({
  invoiceNumber: z.string().nullable().describe("Invoice No. exactly as printed"),
  invoiceDate: z.string().nullable().describe("Invoice date as YYYY-MM-DD"),
  buyerName: z.string().nullable().describe("Buyer (Bill to) contact or business name"),
  buyerCompanyName: z.string().nullable().describe("Buyer company / firm name if different from buyerName"),
  buyerAddress: z.string().nullable().describe("Full buyer billing address on one line"),
  buyerPhone: z.string().nullable(),
  buyerGstin: z.string().nullable().describe("Buyer GSTIN/UIN, 15 characters"),
  shippingAddress: z.string().nullable().describe("Consignee (Ship to) address if different from billing, else null"),
  lines: z.array(z.object({
    description: z.string().describe("Description of goods exactly as printed"),
    productId: z.string().nullable().describe("id of the matching catalog product, or null if none clearly matches"),
    hsn: z.string().nullable(),
    quantity: z.number().describe("Quantity in units/Nos"),
    rateInclusive: z.number().nullable().describe("Per-unit rate including tax, in rupees"),
    rate: z.number().nullable().describe("Per-unit rate excluding tax, in rupees"),
    discountPercent: z.number().nullable(),
    gstPercent: z.number().nullable().describe("GST rate in percent, e.g. 5"),
    amount: z.number().nullable().describe("Line amount (taxable value) in rupees"),
  })),
  totalAmount: z.number().nullable().describe("Grand total payable in rupees"),
});

export type ExtractedInvoice = z.infer<typeof InvoiceSchema>;
export type CatalogProduct = { id: string; sku: string; name: string };

export class InvoiceExtractError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

let client: Anthropic | null = null;

export async function extractInvoice(file: File, catalog: CatalogProduct[]): Promise<ExtractedInvoice> {
  if (!process.env.ANTHROPIC_API_KEY) throw new InvoiceExtractError("Invoice reading is not configured. Add ANTHROPIC_API_KEY to the environment.", 503);
  if (file.size <= 0 || file.size > INVOICE_MAX_BYTES) throw new InvoiceExtractError("Invoice must be up to 3 MB.");
  const isPdf = file.type === "application/pdf";
  if (!isPdf && !IMAGE_TYPES.includes(file.type as ImageType)) throw new InvoiceExtractError("Invoice must be a PDF, JPG, PNG, or WebP.");

  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const source: Anthropic.Beta.BetaContentBlockParam = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: file.type as ImageType, data } };
  const catalogText = catalog.map((product) => `${product.id} | ${product.sku} | ${product.name}`).join("\n");

  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(InvoiceSchema) },
    system: "You read Indian GST tax invoices (often Tally printouts) and transcribe them into structured data. Copy numbers exactly as printed; never compute or guess a value that is not on the invoice - use null instead. The seller is Vasudha; the buyer is the 'Buyer (Bill to)' party.",
    messages: [{
      role: "user",
      content: [
        source,
        { type: "text", text: `Extract this invoice. For each line, set productId to the id of the catalog product that is the same item (match on product name, size and any F-code such as F0003 even if spelling differs); use null when no product clearly matches.\n\nCatalog (id | sku | name):\n${catalogText}` },
      ],
    }],
  });

  if (response.stop_reason === "refusal") throw new InvoiceExtractError("The invoice could not be read. Enter the details manually.", 422);
  const parsed = response.parsed_output;
  if (!parsed) throw new InvoiceExtractError("The invoice could not be read. Enter the details manually.", 422);
  const knownIds = new Set(catalog.map((product) => product.id));
  return { ...parsed, lines: parsed.lines.map((line) => ({ ...line, productId: line.productId && knownIds.has(line.productId) ? line.productId : null })) };
}
