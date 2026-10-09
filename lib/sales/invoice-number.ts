/** Store the sales team's placeholder as missing, so pending orders stay unique by sale number. */
export function normalizeInvoiceNumber(value: string): string | null {
  const number = value.trim();
  return !number || number.toUpperCase() === "NA" ? null : number;
}
