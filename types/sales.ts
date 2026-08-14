export interface SalesLine {
  productId: string | null;
  variantId: string | null;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  currentQuantity: number;
  revenue: number;
}

export interface SalesOrder {
  id: string;
  name: string;
  processedAt: string;
  cancelledAt: string | null;
  revenue: number;
  refunds: number;
  currency: string;
  lines: SalesLine[];
}

export interface SalesReport {
  from: string;
  to: string;
  currency: string;
  orders: number;
  cancelledOrders: number;
  grossRevenue: number;
  refunds: number;
  netRevenue: number;
  averageOrderValue: number;
  projected30DayRevenue: number;
  daily: { date: string; orders: number; units: number; revenue: number; refunds: number }[];
  products: { productId: string | null; title: string; units: number; revenue: number }[];
}
