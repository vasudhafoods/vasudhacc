import type { ExecutiveDashboardData } from "@/types/executive";

type Cell = string | number | boolean | null | undefined;

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cellXml(value: Cell): string {
  if (typeof value === "number" && Number.isFinite(value)) return `<Cell><Data ss:Type="Number">${value}</Data></Cell>`;
  if (typeof value === "boolean") return `<Cell><Data ss:Type="Boolean">${value ? 1 : 0}</Data></Cell>`;
  return `<Cell><Data ss:Type="String">${escapeXml(value == null ? "" : String(value))}</Data></Cell>`;
}

function sheet(name: string, rows: Cell[][]): string {
  const body = rows.map((row) => `<Row>${row.map(cellXml).join("")}</Row>`).join("");
  return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${body}</Table></Worksheet>`;
}

export function buildExecutiveExcel(data: ExecutiveDashboardData): string {
  const { sales, trend, warehouse, inventory } = data;
  const summary: Cell[][] = [
    ["Vasudha Foods Management Command Report"],
    ["Generated at", data.generatedAt],
    ["Reporting period", sales ? `${sales.from} to ${sales.to}` : "Sales unavailable"],
    ["Metric", "Value"],
    ["Net Shopify revenue", sales?.netRevenue ?? "Unavailable"],
    ["Gross Shopify revenue", sales?.grossRevenue ?? "Unavailable"],
    ["Shopify orders", sales?.orders ?? "Unavailable"],
    ["Units sold", trend?.units ?? "Unavailable"],
    ["Average order value", sales?.averageOrderValue ?? "Unavailable"],
    ["Refund rate %", trend?.refundRatePercent ?? "Unavailable"],
    ["Cancellation rate %", trend?.cancellationRatePercent ?? "Unavailable"],
    ["7-day revenue change %", trend?.revenueChangePercent ?? "Unavailable"],
    ["Online allocation packets", warehouse.onlineAllocation],
    ["Retail packets", warehouse.retailStock],
    ["Buffer packets", warehouse.bufferStock],
    ["Total physical packets", warehouse.physicalStock],
    ["Out-of-stock Shopify rows", data.view.outOfStockSkus],
    ["Low-stock Shopify rows", data.view.lowStockSkus],
    ["Failed Shopify events", warehouse.failedShopifyWebhooks],
  ];
  const salesDaily: Cell[][] = [
    ["Date", "Orders", "Units", "Gross revenue", "Refunds", "Net revenue"],
    ...(sales?.daily ?? []).map((day) => [day.date, day.orders, day.units, day.revenue, day.refunds, day.revenue - day.refunds]),
  ];
  const products: Cell[][] = [
    ["Product", "Units sold", "Attributed product revenue", "Current online stock"],
    ...data.products.map((product) => [product.title, product.units, product.revenue, product.onlineStock]),
  ];
  const sources: Cell[][] = [
    ["Attribution coverage %", sales?.marketing.attributionCoveragePercent ?? "Unavailable"],
    ["New customer orders", sales?.marketing.newCustomerOrders ?? "Unavailable"],
    ["Returning customer orders", sales?.marketing.returningCustomerOrders ?? "Unavailable"],
    [],
    ["Source", "Orders", "Units", "Net attributed revenue"],
    ...(sales?.marketing.sources ?? []).map((source) => [source.label, source.orders, source.units, source.revenue]),
  ];
  const campaigns: Cell[][] = [
    ["Campaign", "Orders", "Units", "Net attributed revenue"],
    ...(sales?.marketing.campaigns ?? []).map((campaign) => [campaign.label, campaign.orders, campaign.units, campaign.revenue]),
  ];
  const inventoryRows: Cell[][] = [
    ["Product", "Variant", "SKU", "Location", "Lifecycle", "Tracked", "Today", "Yesterday", "Today change", "Status"],
    ...inventory.items.map((item) => [item.productTitle, item.variantTitle, item.sku, item.locationName, item.productStatus, item.tracked, item.today, item.yesterday, item.todayChange, item.status]),
  ];
  const recommendations: Cell[][] = [
    ["Priority", "Area", "Finding", "Evidence", "Recommended action"],
    ...data.recommendations.map((item) => [item.priority, item.area, item.title, item.evidence, item.action]),
    [],
    ["Missing data / connection"],
    ...data.dataGaps.map((gap) => [gap]),
  ];
  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${[
    sheet("Executive Summary", summary),
    sheet("Sales Daily", salesDaily),
    sheet("Product Performance", products),
    sheet("Marketing Sources", sources),
    sheet("Marketing Campaigns", campaigns),
    sheet("Inventory", inventoryRows),
    sheet("Recommendations", recommendations),
  ].join("")}</Workbook>`;
}
