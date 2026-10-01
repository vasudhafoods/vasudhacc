export type OfflineCustomerType = "retail" | "b2b";
export type OfflinePaymentStatus = "paid" | "partial" | "pending";

export interface OfflineSaleRow {
  id: string;
  saleNumber: string;
  saleDate: string;
  customerName: string;
  customerCompanyName?: string | null;
  customerContact: string | null;
  billingInvoiceNumber: string | null;
  billingAddress: string;
  shippingAddress: string;
  shippingSameAsBilling: boolean;
  gstNumber: string | null;
  customerType: OfflineCustomerType;
  isNewB2bCustomer: boolean;
  totalAmountPaisa: number;
  subtotalAmountPaisa: number;
  discountPaisa: number;
  taxPaisa: number;
  collectedAmountPaisa: number;
  pendingAmountPaisa: number;
  paymentStatus: OfflinePaymentStatus;
  reference: string | null;
  notes: string | null;
  orderType: string;
  requestedDispatchDate?: string | null;
  location: string | null;
  deliveryStatus: string;
  deliveryPartner: string | null;
  deliveryCostPaisa: number | null;
  lrNumber: string | null;
  warehouseLocationId: string | null;
  expectedNextPaymentDate: string | null;
  lines: { productId?: string; sku?: string; productName: string; quantity: number; unitPricePaisa: number; gstRateBps?: number; discountPaisa?: number; taxPaisa?: number; lineTotalPaisa?: number }[];
  createdBy: string;
}

export interface OfflineSalesEntryData {
  products: { id: string; sku: string; name: string; category: "noodles" | "cookies" | "rte" | "other"; unitPricePaisa: number }[];
  locations: { id: string; code: string; name: string }[];
  retailBalances: { productId: string; warehouseLocationId: string; available: number }[];
  customers: SalesCustomer[];
}

export interface SalesCustomer {
  id: string;
  name: string;
  companyName: string | null;
  address: string;
  phone: string;
  gstNumber: string | null;
}

export interface OfflineSalesOverview {
  salesAmountPaisa: number;
  collectedAmountPaisa: number;
  openReceivablesPaisa: number;
  newB2bCustomers: number;
  salesCount: number;
  recentSales: OfflineSaleRow[];
  outstandingSales: OfflineSaleRow[];
}
