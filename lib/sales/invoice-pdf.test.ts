import assert from "node:assert/strict";
import test from "node:test";
import { matchCatalogProduct, parseInvoiceRows, type PdfRow } from "./invoice-pdf";

// Rows laid out like the accounts team's ERPNext Tax Invoice PDF (x positions as pdf.js reports them).
const row = (...cells: [number, string][]): PdfRow => cells.map(([x, text]) => ({ x, text }));
const header = (buyer: PdfRow[], copy = "(ORIGINAL FOR RECIPIENT)"): PdfRow[] => [
  row([469, copy]),
  row([36, "Touchstone Foundation Hyderabad"]),
  row([333, "Invoice No."], [450, "Dated"]),
  row([333, "TSFV/27/0999"], [450, "2026-10-05"]),
  row([36, "GSTIN/UIN: 36AACTT0832H1ZL"]),
  row([36, "State Name : Telangana, Code : 36"]),
  row([36, "Consignee (Ship to)"]),
  ...buyer,
  row([36, "Buyer (Bill to)"]),
  ...buyer,
  row([333, "Terms of Delivery"]),
  row([36, "Sl"], [104, "Description of Goods"], [239, "HSN/SAC"], [287, "GST"], [319, "Quantity"], [376, "Rate"], [520, "Amount"]),
];
const item = (n: string, name: string, hsn: string, qty: string, incl: string, rate: string, disc: string | null, amount: string) =>
  row([37, n], [53, name], [239, hsn], [288, "5"], [294, "%"], [321, qty], [333, "Nos"], [388, incl], [427, rate], [454, "Nos"], ...(disc ? [[477, disc], [487, "%"]] as [number, string][] : []), [541, amount]);

const interStateBuyer = [
  row([36, "Sample Temple Trust"]),
  row([36, "D.NO 1-2-3, Main Road,"], [144, "Sample Town"]),
  row([36, "Guntur, Andhra Pradesh, 522601 State Name"], [240, ": Andhra Pradesh, Code"]),
  row([36, ": 37"]),
];
const interStatePage = [
  ...header(interStateBuyer),
  item("1", "Foxtail Millet Noodles F0002", "19021100", "7.0", "84.00", "80.00", "30", "560.00"),
  item("2", "Kodo Millet Noodles F0003", "19021100", "6.0", "84.00", "80.00", "30", "480.00"),
  item("3", "20g Millet Power Bar Chikkie F0065", "21069099", "500.0", "7.35", "7.00", "39", "3500.00"),
  row([537, "4540.00"]),
  row([209, "IGST"], [391, "5.00"], [438, "%"], [541, "227.00"]),
  row([209, "Total"], [319, "513"], [333, "No's"], [532, "₹"], [537, "4767.00"]),
  row([33, "19021100"], [268, "1040.00"], [328, "5.00%"]),
];

test("reads invoice header, buyer and lines from the first copy only", () => {
  const invoice = parseInvoiceRows([interStatePage, header(interStateBuyer, "(DUPLICATE FOR TRANSPORTER)")]);
  assert.equal(invoice.invoiceNumber, "TSFV/27/0999");
  assert.equal(invoice.invoiceDate, "2026-10-05");
  assert.equal(invoice.buyerName, "Sample Temple Trust");
  assert.equal(invoice.buyerAddress, "D.NO 1-2-3, Main Road, Sample Town Guntur, Andhra Pradesh, 522601");
  assert.equal(invoice.buyerStateCode, "37");
  assert.equal(invoice.interState, true);
  assert.equal(invoice.shippingAddress, null);
  assert.equal(invoice.totalAmount, 4767);
  assert.deepEqual(invoice.lines.map(line => [line.code, line.quantity, line.rateInclusive, line.rate, line.discountPercent, line.gstPercent, line.amount]), [
    ["F0002", 7, 84, 80, 30, 5, 560],
    ["F0003", 6, 84, 80, 30, 5, 480],
    ["F0065", 500, 7.35, 7, 39, 5, 3500],
  ]);
});

test("reads intra-state buyers with phone numbers and lines without discount", () => {
  const buyer = [
    row([36, "Sample Wellness"]),
    row([36, "Road No. 1, Sample Nilayam,"], [200, "Puppalguda,"]),
    row([36, "Hyderabad,, Telangana, 500085"], [200, "Contact_No : 91 90000 00001"]),
    row([36, "State Name"], [100, ": Telangana, Code : 36"]),
  ];
  const invoice = parseInvoiceRows([[
    ...header(buyer),
    item("1", "Finger Millet Noodles F0005", "19021100", "25.0", "120.00", "114.29", null, "2857.25"),
    row([209, "CGST OUTPUT@2.50%"], [541, "71.43"]),
    row([209, "Total"], [532, "₹"], [537, "3000.00"]),
  ]]);
  assert.equal(invoice.buyerPhone, "9000000001");
  assert.equal(invoice.buyerAddress, "Road No. 1, Sample Nilayam, Puppalguda, Hyderabad, Telangana, 500085");
  assert.equal(invoice.interState, false);
  assert.equal(invoice.lines[0].discountPercent, 0);
});

test("unreadable files produce no invoice number or lines", () => {
  const invoice = parseInvoiceRows([[row([36, "Some other document"])]]);
  assert.equal(invoice.invoiceNumber, null);
  assert.equal(invoice.lines.length, 0);
});

const catalog = [
  { id: "foxtail", sku: "F0002-1", name: "Foxtail Millet Noodles 192grams · Pack Of 1" },
  { id: "foxtail-3", sku: "F0002-3", name: "Foxtail Millet Noodles 192grams · Pack Of 3" },
  { id: "kodo", sku: "671253175371", name: "Kodo Millet Noodles 192grams · Pack Of 1" },
  { id: "kodo-3", sku: "671253175372", name: "Kodo Millet Noodles 192grams · Pack Of 3" },
  { id: "sorghum", sku: "F0006-1", name: "Sorghum Millet Noodles 192grams · Pack Of 1" },
  { id: "chikki", sku: "MILLET-CHIKKI", name: "Millet Chikki" },
  { id: "peanut", sku: "CHIKKIS-0003", name: "20g Peanut Chikki" },
];

test("matches invoice items to Pack-of-1 catalog products by item code", () => {
  assert.equal(matchCatalogProduct({ description: "Foxtail Millet Noodles F0002", code: "F0002" }, catalog), "foxtail");
  assert.equal(matchCatalogProduct({ description: "Kodo Millet Noodles F0003", code: "F0003" }, catalog), "kodo");
  assert.equal(matchCatalogProduct({ description: "20g Millet Power Bar Chikkie F0065", code: "F0065" }, catalog), "chikki");
});

test("falls back to product names, tolerating small spelling differences", () => {
  assert.equal(matchCatalogProduct({ description: "Sorgham Millet noodles", code: null }, catalog), "sorghum");
  assert.equal(matchCatalogProduct({ description: "Kodo Noodles", code: "F9999" }, catalog), "kodo");
  assert.equal(matchCatalogProduct({ description: "Peanut Chikki 20g", code: null }, catalog), "peanut");
  assert.equal(matchCatalogProduct({ description: "Something Unrelated", code: null }, catalog), null);
});
