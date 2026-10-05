import "server-only";
import { getDocumentProxy } from "unpdf";
import { matchCatalogProduct, parseInvoiceRows, toRows, type CatalogProduct, type ParsedInvoice } from "@/lib/sales/invoice-pdf";

export const INVOICE_MAX_BYTES = 3 * 1024 * 1024;
export type ExtractedInvoice = ParsedInvoice;

export class InvoiceExtractError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const NOT_READABLE = "This file isn't an accounts invoice PDF. Upload the invoice PDF downloaded from the accounts system, or enter the details manually.";

export async function extractInvoice(file: File, catalog: CatalogProduct[]): Promise<ExtractedInvoice> {
  if (file.size <= 0 || file.size > INVOICE_MAX_BYTES) throw new InvoiceExtractError("Invoice must be up to 3 MB.");
  if (file.type !== "application/pdf") throw new InvoiceExtractError("Auto-fill needs the invoice PDF from the accounts system. Photos and scans can still be attached as the invoice copy, but fill in the details manually.", 422);

  let pages;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    pages = [];
    for (let number = 1; number <= Math.min(pdf.numPages, 10); number += 1) {
      const content = await (await pdf.getPage(number)).getTextContent();
      pages.push(toRows(content.items.filter((item) => "str" in item)));
    }
  } catch {
    throw new InvoiceExtractError(NOT_READABLE, 422);
  }

  const invoice = parseInvoiceRows(pages);
  if (!invoice.invoiceNumber || !invoice.lines.length) throw new InvoiceExtractError(NOT_READABLE, 422);
  return { ...invoice, lines: invoice.lines.map((line) => ({ ...line, productId: matchCatalogProduct(line, catalog) })) };
}
