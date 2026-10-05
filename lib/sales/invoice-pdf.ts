// Reads the accounts team's ERPNext "Tax Invoice" PDF (Touchstone Foundation format) from its text layer.
// Free and deterministic: no OCR or AI, so it only works on the exported PDF, not on photos or scans.

export const SELLER_STATE_CODE = "36"; // Telangana

export type PdfTextItem = { x: number; text: string };
export type PdfRow = PdfTextItem[];

export type InvoiceLine = {
  description: string;
  code: string | null;
  productId: string | null;
  hsn: string;
  quantity: number;
  rateInclusive: number;
  rate: number;
  discountPercent: number;
  gstPercent: number;
  amount: number;
};

export type ParsedInvoice = {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  buyerName: string | null;
  buyerAddress: string | null;
  buyerPhone: string | null;
  buyerGstin: string | null;
  buyerStateCode: string | null;
  shippingAddress: string | null;
  interState: boolean;
  lines: InvoiceLine[];
  totalAmount: number | null;
};

export type CatalogProduct = { id: string; sku: string; name: string };

const rowText = (row: PdfRow) => row.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
const leftText = (row: PdfRow, before: number) => rowText(row.filter((item) => item.x < before));
const number = (value: string) => Number(value.replace(/,/g, ""));

const LINE = /^(\d+) (.+?) (\d{4,8}) ([\d.]+) ?% ([\d.]+) ([A-Za-z']+) ([\d,]+\.\d+) ([\d,]+\.\d+) [A-Za-z']+ (?:([\d.]+) ?% )?([\d,]+\.\d+)$/;

/** Groups pdf.js text items into visual rows, top to bottom, each sorted left to right. */
export function toRows(items: { str: string; transform: number[] }[]): PdfRow[] {
  const rows = new Map<number, PdfRow>();
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const y = Math.round(item.transform[5]);
    const key = [...rows.keys()].find((existing) => Math.abs(existing - y) <= 2) ?? y;
    const row = rows.get(key) ?? [];
    row.push({ x: item.transform[4], text: item.str.trim() });
    rows.set(key, row);
  }
  return [...rows].sort(([a], [b]) => b - a).map(([, row]) => row.sort((a, b) => a.x - b.x));
}

/** Text in the left-hand party column between two headings. */
function partyBlock(rows: PdfRow[], heading: string, stopHeadings: string[], columnEnd: number) {
  const start = rows.findIndex((row) => leftText(row, columnEnd).startsWith(heading));
  if (start < 0) return [];
  const block: string[] = [];
  for (const row of rows.slice(start + 1)) {
    const text = leftText(row, columnEnd);
    if (!text) continue;
    if (stopHeadings.some((stop) => text.startsWith(stop))) break;
    block.push(text);
  }
  return block;
}

function readParty(block: string[]) {
  if (!block.length) return { name: null, address: null, phone: null, gstin: null, stateCode: null };
  const joined = block.join(" ");
  const phone = joined.match(/Contact_No\s*:\s*([+\d][\d\s]{8,})/i)?.[1].replace(/\s+/g, "").replace(/^(?:\+?91)(?=\d{10}$)/, "") ?? null;
  const gstin = joined.match(/GSTIN(?:\/UIN)?\s*:\s*([0-9A-Z]{15})/i)?.[1].toUpperCase() ?? null;
  const stateCode = joined.match(/Code\s*:\s*(\d{2})/)?.[1] ?? gstin?.slice(0, 2) ?? null;
  const address = block.slice(1).join(" ")
    .replace(/State Name\s*:.*$/i, "")
    .replace(/Contact_No\s*:\s*[+\d][\d\s]*/i, "")
    .replace(/GSTIN(?:\/UIN)?\s*:\s*[0-9A-Z]{15}/i, "")
    .replace(/,\s*,/g, ",").replace(/\s+/g, " ").replace(/[\s,]+$/, "").trim();
  return { name: block[0], address: address || null, phone, gstin, stateCode };
}

/** Value printed directly under a box label such as "Invoice No." in the right-hand column. */
function valueUnder(rows: PdfRow[], label: string) {
  for (let index = 0; index < rows.length - 1; index += 1) {
    const labelItem = rows[index].find((item) => item.text.startsWith(label));
    if (!labelItem) continue;
    const value = rows[index + 1].find((item) => Math.abs(item.x - labelItem.x) < 12);
    if (value) return value.text;
  }
  return null;
}

export function parseInvoiceRows(pages: PdfRow[][]): ParsedInvoice {
  const first = pages[0] ?? [];
  const columnEnd = first.find((row) => row.some((item) => item.text.startsWith("Invoice No.")))?.find((item) => item.text.startsWith("Invoice No."))?.x ?? 330;
  const buyer = readParty(partyBlock(first, "Buyer (Bill to)", ["Sl", "Terms of Delivery"], columnEnd - 5));
  const consignee = readParty(partyBlock(first, "Consignee (Ship to)", ["Buyer (Bill to)"], columnEnd - 5));
  const date = valueUnder(first, "Dated");

  const lines: InvoiceLine[] = [];
  let totalAmount: number | null = null;
  let interState = false;
  for (const rows of pages) {
    for (const row of rows) {
      const text = rowText(row);
      const match = text.match(LINE);
      if (match) {
        const description = match[2];
        lines.push({
          description,
          code: description.match(/\bF[0-9A-Z]{4}\b/)?.[0] ?? null,
          productId: null,
          hsn: match[3],
          gstPercent: number(match[4]),
          quantity: number(match[5]),
          rateInclusive: number(match[7]),
          rate: number(match[8]),
          discountPercent: match[9] ? number(match[9]) : 0,
          amount: number(match[10]),
        });
        continue;
      }
      if (/^IGST\b/.test(text)) interState = true;
      const total = text.match(/^Total .*₹ ?([\d,]+\.\d+)$/);
      if (total) { totalAmount = number(total[1]); break; }
      // A wrapped product name continues under the description column.
      const last = lines.at(-1);
      if (last && totalAmount == null && row.every((item) => item.x > 45 && item.x < 230) && !/^(Less|CGST|SGST|IGST)/.test(text)) {
        last.description = `${last.description} ${text}`;
        last.code ??= text.match(/\bF[0-9A-Z]{4}\b/)?.[0] ?? null;
      }
    }
    if (totalAmount != null) break; // Later pages are DUPLICATE / TRIPLICATE copies.
  }

  const buyerStateCode = buyer.stateCode;
  return {
    invoiceNumber: valueUnder(first, "Invoice No."),
    invoiceDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    buyerName: buyer.name,
    buyerAddress: buyer.address,
    buyerPhone: buyer.phone,
    buyerGstin: buyer.gstin,
    buyerStateCode,
    shippingAddress: consignee.address && consignee.address !== buyer.address ? consignee.address : null,
    interState: interState || (buyerStateCode != null && buyerStateCode !== SELLER_STATE_CODE),
    lines,
    totalAmount,
  };
}

// Invoice item codes whose catalog SKU is not "<code>-1".
const CODE_TO_SKU: Record<string, string> = { F0003: "671253175371", F0065: "MILLET-CHIKKI" };
const IGNORED_WORDS = new Set(["g", "grams", "pack", "of", "millet", "and"]);

function words(value: string) {
  return value.toLowerCase().replace(/·.*$/, "").replace(/\bf[0-9a-z]{4}\b/g, " ").split(/[^a-z]+/).filter((word) => word.length > 1 && !IGNORED_WORDS.has(word));
}
function closeEnough(a: string, b: string) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let differences = 0;
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++differences > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return true;
}

/** Finds the Pack-of-1 catalog product for an invoice line, by item code first and name second. */
export function matchCatalogProduct(line: Pick<InvoiceLine, "description" | "code">, catalog: CatalogProduct[]): string | null {
  const bySku = (sku: string) => catalog.find((product) => product.sku.toUpperCase() === sku.toUpperCase())?.id ?? null;
  if (line.code) {
    const id = (CODE_TO_SKU[line.code] && bySku(CODE_TO_SKU[line.code])) || bySku(`${line.code}-1`) || bySku(line.code);
    if (id) return id;
  }
  const wanted = words(line.description);
  const scored = catalog
    .filter((product) => !/pack of (?!1\b)\d+/i.test(product.name))
    .map((product) => ({ id: product.id, score: words(product.name).filter((word) => wanted.some((other) => closeEnough(word, other))).length }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score);
  return scored.length && (scored.length === 1 || scored[0].score > scored[1].score) ? scored[0].id : null;
}
