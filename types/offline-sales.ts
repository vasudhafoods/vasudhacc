export type OfflineCustomerType = "retail" | "b2b";
export type OfflinePaymentStatus = "paid" | "partial" | "pending";

export interface OfflineSaleRow {
  id: string;
  saleNumber: string;
  saleDate: string;
  customerName: string;
  customerContact: string | null;
  customerType: OfflineCustomerType;
  isNewB2bCustomer: boolean;
  totalAmountPaisa: number;
  collectedAmountPaisa: number;
  pendingAmountPaisa: number;
  paymentStatus: OfflinePaymentStatus;
  reference: string | null;
  notes: string | null;
  createdBy: string;
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
