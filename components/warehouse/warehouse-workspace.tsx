"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { WarehouseStockCondition } from "@/components/warehouse/warehouse-stock-condition";
import { WarehouseReturnDisposal } from "@/components/warehouse/warehouse-return-disposal";
import { WarehouseOrdersPanel } from "@/components/warehouse/warehouse-orders-panel";
import { receiptAllocation } from "@/lib/inventory/allocation";
import type { DashboardRole } from "@/types/auth";
import type { ShopifySyncStatus, WarehouseInventoryBucket, WarehouseProductOption, WarehouseWorkspaceData } from "@/types/warehouse";

type Panel = "stock-condition" | "dashboard" | "orders" | "receive" | "dispatch" | "returns" | "disposal" | "product" | "activity";
type Step = "edit" | "review" | "success";

interface ReceiptDraft {
  warehouseLocationId: string;
  source: string;
  supplierName: string;
  invoiceValue: string;
  referenceId: string;
  receiptDate: string;
}

interface ReceiptLineDraft {
  id: string;
  category: "noodles" | "cookies" | "rte" | "other";
  productId: string;
  batchNumber: string;
  receivedQuantity: string;
  damagedQuantity: string;
  expiryDate: string;
}

interface ProductDraft {
  sku: string;
  name: string;
  packSize: string;
  barcode: string;
  category: "noodles" | "cookies" | "rte" | "other";
  unitPrice: string;
}

interface DispatchLineDraft {
  id: string;
  productId: string;
  quantity: string;
  unitPrice: string;
}

interface DispatchDraft {
  warehouseLocationId: string;
  destination: string;
  referenceId: string;
  deliveryDate: string;
  orderType: "retail" | "sample" | "inhand" | "other";
  orderValue: string;
  deliveryStatus: "packing" | "shipped" | "dispatched" | "delivered";
  deliveryPartner: string;
  deliveryCost: string;
  lrNumber: string;
  invoiceFile: File | null;
  acknowledgementFile: File | null;
  notes: string;
  lines: DispatchLineDraft[];
}

interface ReturnDraft {
  channel: "retail" | "shopify";
  productId: string;
  warehouseLocationId: string;
  quantity: string;
  referenceId: string;
  reason: string;
  notes: string;
}

interface QcDraft {
  productId: string;
  warehouseLocationId: string;
  quantity: string;
  toBucket: "online" | "retail" | "buffer" | "damaged";
  referenceId: string;
  reason: string;
}

interface DisposalDraft {
  productId: string;
  warehouseLocationId: string;
  sourceBucket: WarehouseInventoryBucket;
  quantity: string;
  disposalReason: "expired" | "damaged" | "contaminated" | "quality_rejected" | "other";
  referenceId: string;
  notes: string;
}

interface ReceiptSuccess {
  transactionId: string;
  transactionNumber: string;
  receivedQuantity: number;
  shopifySync: ShopifySyncStatus;
}

interface RetailDispatchSuccess {
  transactionId: string;
  transactionNumber: string;
  totalQuantity: number;
  destination: string;
  stockTransferTransactionId: string | null;
  shopifySync: ShopifySyncStatus;
  lines: { productId: string; productName: string; sku: string; quantity: number; closingRetailBalance: number; movedFromBuffer: number; movedFromOnline: number }[];
}

interface ReturnSuccess {
  transactionNumber: string;
  quantity: number;
  qcClosingBalance: number;
  channel: "retail" | "shopify";
}

interface QcSuccess {
  transactionNumber: string;
  fromClosingBalance: number;
  toClosingBalance: number;
  shopifySync: ShopifySyncStatus;
}

interface DisposalSuccess {
  transactionNumber: string;
  quantity: number;
  sourceBucket: WarehouseInventoryBucket;
  closingBalance: number;
  shopifySync: ShopifySyncStatus;
}

const EMPTY_PRODUCT: ProductDraft = { sku: "", name: "", packSize: "", barcode: "", category: "other", unitPrice: "" };

function quantity(value: string): number {
  if (value.trim() === "") return 0;
  return Number(value);
}

function localDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(value));
}

function ErrorMessage({ message }: { message: string | null }) {
  return message ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800" role="alert">{message}</div> : null;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block">
    <span className="mb-2 block text-sm font-semibold text-slate-800">{label}</span>
    {children}
    {hint ? <span className="mt-1.5 block text-xs leading-5 text-slate-500">{hint}</span> : null}
  </label>;
}

function SummaryRow({ label, value, strong = false }: { label: string; value: ReactNode; strong?: boolean }) {
  return <div className="flex items-start justify-between gap-5 border-b border-slate-100 py-3 last:border-0">
    <dt className="text-sm text-slate-500">{label}</dt><dd className={`text-right text-sm ${strong ? "font-bold text-slate-950" : "font-semibold text-slate-800"}`}>{value}</dd>
  </div>;
}

export function WarehouseWorkspace({ user, initialData }: {
  user: { displayName: string; username: string; role: DashboardRole };
  initialData: WarehouseWorkspaceData;
}) {
  const router = useRouter();
  const canReviewWarehouseDisposals = user.role === "admin" || user.role === "management";
  const firstProduct = initialData.products[0]?.id ?? "";
  const firstLocation = initialData.locations[0]?.id ?? "";
  const [panel, setPanel] = useState<Panel>("dashboard");
  const [receiptStep, setReceiptStep] = useState<Step>("edit");
  const [dispatchStep, setDispatchStep] = useState<Step>("edit");
  const [productStep, setProductStep] = useState<Step>("edit");
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [receiptSuccess, setReceiptSuccess] = useState<ReceiptSuccess | null>(null);
  const [dispatchSuccess, setDispatchSuccess] = useState<RetailDispatchSuccess | null>(null);
  const [dispatchDocumentLinks, setDispatchDocumentLinks] = useState<{ id: string; fileName: string; url: string }[]>([]);
  const [createdProduct, setCreatedProduct] = useState<WarehouseProductOption | null>(null);
  const [addToShopify, setAddToShopify] = useState(false);
  const [createdShopifyStatus, setCreatedShopifyStatus] = useState<string>("Retail only (not on Shopify)");
  const [receipt, setReceipt] = useState<ReceiptDraft>({
    warehouseLocationId: firstLocation,
    source: "Production / supplier delivery",
    supplierName: "",
    invoiceValue: "",
    referenceId: "",
    receiptDate: new Date().toISOString().slice(0, 10),
  });
  const [receiptLines, setReceiptLines] = useState<ReceiptLineDraft[]>([{ id: crypto.randomUUID(), category: initialData.products[0]?.category ?? "other", productId: firstProduct, batchNumber: "", receivedQuantity: "", damagedQuantity: "0", expiryDate: "" }]);
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);
  const [receiptAttachmentLinks, setReceiptAttachmentLinks] = useState<{ id: string; fileName: string; url: string }[]>([]);
  const [product, setProduct] = useState<ProductDraft>(EMPTY_PRODUCT);
  const [dispatch, setDispatch] = useState<DispatchDraft>({
    warehouseLocationId: firstLocation,
    destination: "",
    referenceId: "",
    deliveryDate: new Date().toISOString().slice(0, 10),
    orderType: "retail",
    orderValue: "",
    deliveryStatus: "packing",
    deliveryPartner: "",
    deliveryCost: "",
    lrNumber: "",
    invoiceFile: null,
    acknowledgementFile: null,
    notes: "",
    lines: [{ id: crypto.randomUUID(), productId: firstProduct, quantity: "", unitPrice: "" }],
  });

  const selectedLocation = initialData.locations.find((item) => item.id === receipt.warehouseLocationId) ?? null;
  const receiptAllocations = receiptLines.map((line) => {
    const receivedQuantity = quantity(line.receivedQuantity);
    const damagedQuantity = quantity(line.damagedQuantity);
    const usableQuantity = Math.max(0, receivedQuantity - damagedQuantity);
    const { online: onlineQuantity, retail: retailQuantity, buffer: bufferQuantity } = receiptAllocation(usableQuantity);
    return { line, receivedQuantity, damagedQuantity, onlineQuantity, retailQuantity, bufferQuantity };
  });
  const receivedQuantity = receiptAllocations.reduce((sum, allocation) => sum + allocation.receivedQuantity, 0);
  const onlineQuantity = receiptAllocations.reduce((sum, allocation) => sum + allocation.onlineQuantity, 0);
  const retailQuantity = receiptAllocations.reduce((sum, allocation) => sum + allocation.retailQuantity, 0);
  const bufferQuantity = receiptAllocations.reduce((sum, allocation) => sum + allocation.bufferQuantity, 0);
  const damagedQuantity = receiptAllocations.reduce((sum, allocation) => sum + allocation.damagedQuantity, 0);
  const dispatchTotal = dispatch.lines.reduce((total, line) => total + (Number.isSafeInteger(quantity(line.quantity)) ? quantity(line.quantity) : 0), 0);
  const dispatchLocation = initialData.locations.find((location) => location.id === dispatch.warehouseLocationId) ?? null;

  const activityCounts = useMemo(() => ({
    receipts: initialData.activities.filter((activity) => activity.kind === "stock_received").length,
    dispatches: initialData.activities.filter((activity) => activity.kind === "retail_dispatched").length,
    transfers: initialData.activities.filter((activity) => activity.kind === "stock_transferred").length,
    products: initialData.activities.filter((activity) => activity.kind === "product_created").length,
  }), [initialData.activities]);

  function bucketAvailable(productId: string, bucket: WarehouseInventoryBucket): number {
    return initialData.balances.find((balance) => balance.productId === productId && balance.warehouseLocationId === dispatch.warehouseLocationId && balance.bucket === bucket)?.available ?? 0;
  }

  function dispatchAvailable(productId: string): number {
    return (["retail", "buffer", "online"] as const).reduce((total, bucket) => total + bucketAvailable(productId, bucket), 0);
  }

  function retailShortfall(productId: string, quantityToDispatch: number): number {
    return Math.max(0, quantityToDispatch - bucketAvailable(productId, "retail"));
  }

  function dispatchMovement(productId: string, quantityToDispatch: number) {
    const shortfall = retailShortfall(productId, quantityToDispatch);
    const movedFromBuffer = Math.min(shortfall, bucketAvailable(productId, "buffer"));
    return { movedFromBuffer, movedFromOnline: Math.max(0, shortfall - movedFromBuffer) };
  }

  function updateReceipt<K extends keyof ReceiptDraft>(key: K, value: ReceiptDraft[K]) {
    setReceipt((current) => ({ ...current, [key]: value }));
    setReceiptError(null);
  }

  function updateReceiptLine(id: string, key: keyof Omit<ReceiptLineDraft, "id">, value: string | boolean) {
    setReceiptLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      if (key === "category") {
        const category = value as ReceiptLineDraft["category"];
        return { ...line, category, productId: initialData.products.find((product) => product.category === category)?.id ?? "" };
      }
      if (key === "productId") {
        const selected = initialData.products.find((product) => product.id === value);
        return { ...line, productId: String(value), category: selected?.category ?? line.category };
      }
      return { ...line, [key]: value };
    }));
    setReceiptError(null);
  }

  function addReceiptLine() {
    setReceiptLines((current) => [...current, { id: crypto.randomUUID(), category: initialData.products[0]?.category ?? "other", productId: firstProduct, batchNumber: "", receivedQuantity: "", damagedQuantity: "0", expiryDate: "" }]);
  }

  function removeReceiptLine(id: string) {
    setReceiptLines((current) => current.length > 1 ? current.filter((line) => line.id !== id) : current);
  }

  function updateProduct<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) {
    setProduct((current) => ({ ...current, [key]: value }));
    setProductError(null);
  }

  function updateDispatch<K extends keyof Omit<DispatchDraft, "lines">>(key: K, value: DispatchDraft[K]) {
    setDispatch((current) => ({ ...current, [key]: value }));
    setDispatchError(null);
  }

  function updateDispatchLine(id: string, key: "productId" | "quantity" | "unitPrice", value: string) {
    setDispatch((current) => ({ ...current, lines: current.lines.map((line) => line.id === id ? { ...line, [key]: value } : line) }));
    setDispatchError(null);
  }

  function updateDispatchFile(key: "invoiceFile" | "acknowledgementFile", file: File | null) {
    setDispatch((current) => ({ ...current, [key]: file }));
    setDispatchError(null);
  }

  function addDispatchLine() {
    setDispatch((current) => ({ ...current, lines: [...current.lines, { id: crypto.randomUUID(), productId: "", quantity: "", unitPrice: "" }] }));
  }

  function removeDispatchLine(id: string) {
    setDispatch((current) => ({ ...current, lines: current.lines.length === 1 ? current.lines : current.lines.filter((line) => line.id !== id) }));
    setDispatchError(null);
  }

  function reviewReceipt(event: FormEvent) {
    event.preventDefault();
    if (!selectedLocation) return setReceiptError("Select a warehouse location.");
    if (!receipt.supplierName.trim() || !receipt.referenceId.trim()) return setReceiptError("Enter the supplier and invoice number.");
    const invoiceValuePaisa = Math.round(Number(receipt.invoiceValue) * 100);
    if (!Number.isSafeInteger(invoiceValuePaisa) || invoiceValuePaisa <= 0) return setReceiptError("Enter a valid invoice value greater than zero.");
    if (!receiptFiles.length) return setReceiptError("Upload at least one invoice or supporting file.");
    if (!receiptLines.length || receiptAllocations.some(({ line, receivedQuantity, damagedQuantity }) => !line.category || !line.productId || initialData.products.find((product) => product.id === line.productId)?.category !== line.category || !line.batchNumber.trim() || !Number.isSafeInteger(receivedQuantity) || receivedQuantity <= 0 || !Number.isSafeInteger(damagedQuantity) || damagedQuantity < 0 || damagedQuantity > receivedQuantity || !line.expiryDate)) return setReceiptError("Complete every product row, including matching category and product, batch, quantity, damaged quantity, and expiry date.");
    if (receiptAllocations.some(({ line }) => line.expiryDate < receipt.receiptDate)) return setReceiptError("Expiry date cannot be before the receiving date.");
    for (const allocation of receiptAllocations) {
      const product = initialData.products.find((item) => item.id === allocation.line.productId);
      if (product?.onShopify && !product.shopifyMappingId) return setReceiptError(`${product.name} has conflicting Shopify listings. Fix the mapping and run catalog sync before receiving stock.`);
    }
    setReceiptError(null);
    setIdempotencyKey(crypto.randomUUID());
    setReceiptStep("review");
  }

  async function submitReceipt() {
    if (!selectedLocation || !idempotencyKey) return;
    setSubmitting(true);
    setReceiptError(null);
    try {
      let latest: ReceiptSuccess | null = null;
      let firstTransactionId: string | null = null;
      let sync: ShopifySyncStatus = "not_required";
      for (const allocation of receiptAllocations) {
        const product = initialData.products.find((item) => item.id === allocation.line.productId)!;
        const response = await fetch("/api/warehouse/receipts", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": `${idempotencyKey}:${allocation.line.id}` },
          body: JSON.stringify({ ...receipt, productId: allocation.line.productId, addToShopify: true, invoiceTransactionId: firstTransactionId ?? undefined, batchNumber: allocation.line.batchNumber, expiryDate: allocation.line.expiryDate || undefined, receivedQuantity: allocation.receivedQuantity, damagedQuantity: allocation.damagedQuantity, onlineQuantity: allocation.onlineQuantity, retailQuantity: allocation.retailQuantity, bufferQuantity: allocation.bufferQuantity, invoiceValue: firstTransactionId ? "" : receipt.invoiceValue, shopifyMappingId: allocation.onlineQuantity > 0 ? product.shopifyMappingId : undefined }),
        });
        const body = await response.json() as { result?: ReceiptSuccess; error?: { message?: string } };
        if (!response.ok || !body.result) throw new Error(body.error?.message ?? "Stock could not be submitted.");
        latest = body.result;
        firstTransactionId ??= body.result.transactionId;
        if (body.result.shopifySync === "pending" || body.result.shopifySync === "failed") sync = body.result.shopifySync;
        else if (body.result.shopifySync === "succeeded" && sync === "not_required") sync = "succeeded";
      }
      if (!latest) throw new Error("Add at least one product row.");
      if (receiptFiles.length && firstTransactionId) {
        const formData = new FormData();
        receiptFiles.forEach((file) => formData.append("files", file));
        const upload = await fetch(`/api/warehouse/receipts/${firstTransactionId}/attachments`, { method: "POST", body: formData });
        const uploadBody = await upload.json() as { error?: { message?: string } };
        if (!upload.ok) throw new Error(`Stock was received, but invoice files were not saved: ${uploadBody.error?.message ?? "Upload failed."} Submit again to retry the upload.`);
        const listed = await fetch(`/api/warehouse/receipts/${firstTransactionId}/attachments`, { cache: "no-store" });
        const attachmentBody = await listed.json() as { files?: { id: string; fileName: string; url: string }[] };
        if (listed.ok) setReceiptAttachmentLinks(attachmentBody.files ?? []);
      }
      setReceiptSuccess({ ...latest, receivedQuantity, shopifySync: sync });
      setReceiptStep("success");
      router.refresh();
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : "Stock could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  function reviewDispatch(event: FormEvent) {
    event.preventDefault();
    if (!dispatch.warehouseLocationId) return setDispatchError("Select a warehouse location.");
    if (!dispatch.destination.trim()) return setDispatchError("Enter the shop, distributor, or customer receiving this stock.");
    if (!dispatch.referenceId.trim()) return setDispatchError("Enter the invoice, order, or dispatch reference.");
    if (!dispatch.deliveryDate || !dispatch.destination.trim() || !dispatch.deliveryPartner.trim() || !dispatch.lrNumber.trim()) return setDispatchError("Complete the delivery date, customer, delivery partner, and LR number.");
    if (!dispatch.invoiceFile || !dispatch.acknowledgementFile) return setDispatchError("Upload both the invoice and acknowledgement files.");
    const documents = [dispatch.invoiceFile, dispatch.acknowledgementFile];
    const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
    if (documents.some((file) => file.size > 3 * 1024 * 1024 || !allowedTypes.has(file.type)) || documents.reduce((sum, file) => sum + file.size, 0) > 3_500 * 1024) return setDispatchError("Each document must be a PDF or image up to 3 MB; both together must be 3.5 MB or less.");
    const orderValuePaisa = Math.round(Number(dispatch.orderValue) * 100);
    const deliveryCostPaisa = Math.round(Number(dispatch.deliveryCost) * 100);
    if (!Number.isSafeInteger(orderValuePaisa) || orderValuePaisa <= 0) return setDispatchError("Enter an order value greater than zero.");
    if (!Number.isSafeInteger(deliveryCostPaisa) || deliveryCostPaisa < 0 || dispatch.deliveryCost.trim() === "") return setDispatchError("Enter the delivery cost (use 0 if there is no charge).");
    const seen = new Set<string>();
    for (const line of dispatch.lines) {
      const lineQuantity = quantity(line.quantity);
      if (!line.productId) return setDispatchError("Select a product on every line.");
      if (seen.has(line.productId)) return setDispatchError("The same product is listed twice. Keep one line and enter the combined quantity.");
      if (!Number.isSafeInteger(lineQuantity) || lineQuantity <= 0) return setDispatchError("Enter a positive whole-packet quantity on every line.");
      const unitPricePaisa = Math.round(Number(line.unitPrice) * 100);
      if (!Number.isSafeInteger(unitPricePaisa) || unitPricePaisa <= 0) return setDispatchError("Enter a unit sale price greater than zero on every product line.");
      if (lineQuantity > dispatchAvailable(line.productId)) return setDispatchError(`Only ${dispatchAvailable(line.productId)} packets are available across Retail, Buffer, and Online for ${initialData.products.find((product) => product.id === line.productId)?.name ?? "this product"}.`);
      seen.add(line.productId);
    }
    setDispatchError(null);
    setIdempotencyKey(crypto.randomUUID());
    setDispatchStep("review");
  }

  async function submitDispatch() {
    if (!idempotencyKey) return;
    setSubmitting(true);
    setDispatchError(null);
    try {
      const response = await fetch("/api/warehouse/retail-dispatches", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ ...dispatch, orderValuePaisa: Math.round(Number(dispatch.orderValue) * 100), deliveryCostPaisa: Math.round(Number(dispatch.deliveryCost) * 100), lines: dispatch.lines.map((line) => ({ productId: line.productId, quantity: quantity(line.quantity), unitPricePaisa: Math.round(Number(line.unitPrice) * 100) })) }),
      });
      const body = await response.json() as { result?: RetailDispatchSuccess; error?: { message?: string } };
      if (!response.ok || !body.result) throw new Error(body.error?.message ?? "Retail dispatch could not be submitted.");
      for (const [kind, file] of [["Invoice", dispatch.invoiceFile], ["Acknowledgement", dispatch.acknowledgementFile]] as const) {
        if (!file) throw new Error(`The ${kind.toLowerCase()} file is required.`);
        const formData = new FormData();
        formData.set("transactionId", body.result.transactionId);
        formData.set("kind", kind);
        formData.set("file", file);
        const upload = await fetch("/api/warehouse/retail-dispatches", { method: "PUT", body: formData });
        const uploadBody = await upload.json() as { error?: { message?: string } };
        if (!upload.ok) throw new Error(`Delivery was recorded, but its ${kind.toLowerCase()} file failed to save: ${uploadBody.error?.message ?? "Upload failed."}`);
      }
      const listed = await fetch(`/api/warehouse/retail-dispatches?transactionId=${encodeURIComponent(body.result.transactionId)}`, { cache: "no-store" });
      const fileBody = await listed.json() as { files?: { id: string; fileName: string; url: string }[] };
      setDispatchDocumentLinks(fileBody.files ?? []);
      setDispatchSuccess(body.result);
      setDispatchStep("success");
      router.refresh();
    } catch (error) {
      setDispatchError(error instanceof Error ? error.message : "Retail dispatch could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  function startAnotherDispatch() {
    setDispatch((current) => ({ ...current, destination: "", referenceId: "", orderValue: "", deliveryPartner: "", deliveryCost: "", lrNumber: "", invoiceFile: null, acknowledgementFile: null, deliveryDate: new Date().toISOString().slice(0, 10), orderType: "retail", deliveryStatus: "packing", notes: "", lines: [{ id: crypto.randomUUID(), productId: firstProduct, quantity: "", unitPrice: "" }] }));
    setDispatchSuccess(null);
    setIdempotencyKey("");
    setDispatchError(null);
    setDispatchStep("edit");
  }

  function startAnotherReceipt() {
    setReceipt((current) => ({
      ...current,
      referenceId: "",
    }));
      setReceiptLines([{ id: crypto.randomUUID(), category: initialData.products[0]?.category ?? "other", productId: firstProduct, batchNumber: "", receivedQuantity: "", damagedQuantity: "0", expiryDate: "" }]);
    setReceiptFiles([]);
    setReceiptAttachmentLinks([]);
    setReceiptSuccess(null);
    setIdempotencyKey("");
    setReceiptError(null);
    setReceiptStep("edit");
  }

  function reviewProduct(event: FormEvent) {
    event.preventDefault();
    if (product.name.trim().length < 2) return setProductError("Enter the full product name.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{1,59}$/.test(product.sku.trim())) return setProductError("Enter a valid SKU using letters, numbers, dots, dashes, slashes, or underscores.");
    setProductError(null);
    setProductStep("review");
  }

  /** Lists a catalog product on Shopify; returns an error message, or null when it worked. */
  async function listOnShopify(productId: string): Promise<string | null> {
    try {
      const response = await fetch(`/api/warehouse/products/${productId}/shopify`, { method: "POST" });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) return body.error?.message ?? "The product could not be added to Shopify.";
      router.refresh();
      return null;
    } catch {
      return "The product could not be added to Shopify. Check your connection and try again.";
    }
  }

  async function submitProduct() {
    setSubmitting(true);
    setProductError(null);
    try {
      const response = await fetch("/api/warehouse/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(product),
      });
      const body = await response.json() as { product?: WarehouseProductOption; error?: { message?: string } };
      if (!response.ok || !body.product) throw new Error(body.error?.message ?? "Product could not be created.");
      setCreatedProduct(body.product);
      if (addToShopify) {
        const shopifyError = await listOnShopify(body.product.id);
        setCreatedShopifyStatus(shopifyError ? `Not added: ${shopifyError} Try again later or add it in Shopify admin.` : "Added to Shopify. Add images and make it available on the Online Store in Shopify admin to start selling.");
      } else setCreatedShopifyStatus("Retail only (not on Shopify)");
      setProductStep("success");
      router.refresh();
    } catch (error) {
      setProductError(error instanceof Error ? error.message : "Product could not be created.");
    } finally {
      setSubmitting(false);
    }
  }

  function changePanel(next: Panel) {
    setPanel(next);
    setReceiptError(null);
    setDispatchError(null);
    setProductError(null);
  }

  const inputClass = "h-12 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 outline-none transition focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";
  const stockDashboardRows = initialData.locations.flatMap((location) => {
    const grouped = new Map<string, { name: string; category: string; total: number; saleable: number; qc: number; damaged: number }>();
    for (const product of initialData.products) {
      const baseName = product.name.replace(/\s*[·|–—-]\s*pack\s+of\s+\d+\b.*$/i, "").trim() || product.name;
      const key = baseName.toLocaleLowerCase();
      const row = grouped.get(key) ?? { name: baseName, category: product.category, total: 0, saleable: 0, qc: 0, damaged: 0 };
      for (const balance of initialData.balances.filter((balance) => balance.productId === product.id && balance.warehouseLocationId === location.id)) {
        row.total += balance.onHand;
        if (balance.bucket === "damaged") row.damaged += balance.onHand;
        else if (balance.bucket === "qc") row.qc += balance.onHand;
        else row.saleable += balance.onHand;
      }
      grouped.set(key, row);
    }
    return [...grouped.values()].filter((row) => row.total > 0 || initialData.locations.length === 1).map((row) => ({ ...row, locationName: location.name }));
  });
  return <div className="space-y-6 pb-12">
    <section className="rounded-2xl bg-brand-primary px-5 py-6 text-white shadow-sm sm:px-7">
      <p className="text-xs font-semibold uppercase tracking-[.16em] text-emerald-200">Warehouse desk</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Hello, {user.displayName}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-50">Choose one task below. Nothing changes until you review the summary and press the final Submit button.</p>
    </section>

    <nav className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Warehouse tasks">
      {([
        ["dashboard", "1", "Stock dashboard", "View current inventory"],
        ["orders", "2", "Orders", "Shopify and retail fulfillment"],
        ["receive", "3", "Receive stock", "Enter a new delivery"],
        ["dispatch", "4", "Deliver stock", "Record an offline order"],
        ["returns", "5", "Return on order", "Record RTO or customer returns"],
        ["disposal", "6", "Disposal", "Record removed stock"],
        ["product", "7", "Add new product", "Create a product record"],
        ["activity", "8", "My updates", "Check what you submitted"],
        ["stock-condition", "9", "Damaged & QC / Hold", "View buckets and move stock"],
      ] as const).map(([key, number, title, subtitle]) => <button key={key} type="button" onClick={() => changePanel(key)} className={`flex min-h-20 items-center gap-3 rounded-2xl border p-4 text-left transition ${panel === key ? "border-emerald-700 bg-emerald-50 ring-2 ring-emerald-100" : "border-slate-200 bg-white hover:border-emerald-300"}`}>
        <span className={`grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold ${panel === key ? "bg-brand-primary text-white" : "bg-slate-100 text-slate-600"}`}>{number}</span>
        <span><span className="block text-sm font-bold text-slate-900">{title}</span><span className="mt-0.5 block text-xs text-slate-500">{subtitle}</span></span>
      </button>)}
    </nav>

    {panel === "dashboard" ? <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-7"><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">View only</p><h2 className="mt-1 text-xl font-bold text-slate-950">Stock dashboard</h2><p className="mt-1 text-sm text-slate-500">Current physical stock by product and warehouse, including reserved packets. Saleable stock excludes Damaged and QC / Hold.</p></div>
      <div className="space-y-6 p-5 sm:p-7">
        <button type="button" onClick={() => changePanel("orders")} className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-left hover:bg-emerald-50"><span><span className="block font-bold text-slate-900">Sales orders to prepare</span><span className="mt-1 block text-xs text-slate-600">Open the Orders page to track Shopify and Retail orders.</span></span><span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">{initialData.salesOrders.filter((order) => !["delivered", "cancelled"].includes(order.deliveryStatus)).length} active →</span></button>
        <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Product</th><th className="px-4 py-3">Warehouse</th><th className="px-4 py-3 text-right">Saleable</th><th className="px-4 py-3 text-right">QC / Hold</th><th className="px-4 py-3 text-right">Damaged</th><th className="px-4 py-3 text-right">Total physical</th></tr></thead><tbody>
          {stockDashboardRows.map((row) => <tr key={`${row.name}-${row.locationName}`} className="border-t border-slate-100"><td className="px-4 py-3"><span className="block font-semibold text-slate-900">{row.name}</span><span className="text-xs capitalize text-slate-500">{row.category}</span></td><td className="px-4 py-3 text-slate-600">{row.locationName}</td><td className="px-4 py-3 text-right font-semibold tabular-nums">{row.saleable}</td><td className="px-4 py-3 text-right font-semibold tabular-nums text-amber-800">{row.qc}</td><td className="px-4 py-3 text-right font-semibold tabular-nums text-red-700">{row.damaged}</td><td className="px-4 py-3 text-right text-lg font-bold tabular-nums text-slate-950">{row.total}</td></tr>)}
          {!initialData.products.length ? <tr><td className="px-4 py-10 text-center text-slate-500" colSpan={6}>No active products yet.</td></tr> : null}
        </tbody></table></div>
      </div>
    </section> : null}

    {panel === "orders" ? <WarehouseOrdersPanel salesOrders={initialData.salesOrders} shopifyOrders={initialData.shopifyOrders} shopifyOrdersError={initialData.shopifyOrdersError} migrationPending={initialData.salesOrdersMigrationPending} documents={initialData.orderDocuments}/> : null}

    {panel === "receive" ? <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-7"><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">{receiptStep === "edit" ? "Step 1 of 2 · Enter" : receiptStep === "review" ? "Step 2 of 2 · Review" : "Completed"}</p><h2 className="mt-1 text-xl font-bold text-slate-950">{receiptStep === "success" ? "Stock submitted successfully" : "Receive new stock"}</h2></div>
      <div className="p-5 sm:p-7">
        {receiptStep === "edit" ? <form className="space-y-6" onSubmit={reviewReceipt}>
          <ErrorMessage message={receiptError}/>
          {!initialData.products.length || !initialData.locations.length ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">{!initialData.products.length ? "No active products are available. Add a product first. " : ""}{!initialData.locations.length ? "No warehouse location is configured. Ask an administrator to configure one." : ""}</div> : null}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <Field label="Date"><input className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" type="date" value={receipt.receiptDate} onChange={(event) => updateReceipt("receiptDate", event.target.value)} required/></Field>
            <Field label="Supplier name"><input className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" value={receipt.supplierName} onChange={(event) => updateReceipt("supplierName", event.target.value)} required/></Field>
            <Field label="Invoice number"><input className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" value={receipt.referenceId} onChange={(event) => updateReceipt("referenceId", event.target.value)} required/></Field>
            <Field label="Invoice value (₹)"><input className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" type="number" min="0.01" step="0.01" value={receipt.invoiceValue} onChange={(event) => updateReceipt("invoiceValue", event.target.value)} required/></Field>
            <Field label="Warehouse location"><select className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" value={receipt.warehouseLocationId} onChange={(event) => updateReceipt("warehouseLocationId", event.target.value)} required><option value="">Choose location</option>{initialData.locations.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}</select></Field>
          </div>
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4"><label className="block text-sm font-semibold text-slate-800">Invoice or supporting files <span className="font-normal text-slate-500">PDF, JPG, PNG, or WebP · up to 5 files, 3 MB each (3.5 MB total)</span><input className="mt-2 block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-100 file:px-4 file:py-2 file:text-sm file:font-bold file:text-emerald-900 hover:file:bg-emerald-200" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple required onChange={(event) => { const files = Array.from(event.target.files ?? []); const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]); if (files.length > 5 || files.some((file) => file.size > 3 * 1024 * 1024 || !allowed.has(file.type)) || files.reduce((sum, file) => sum + file.size, 0) > 3_500 * 1024) { setReceiptError("Choose up to 5 PDF or image files, each 3 MB or less and 3.5 MB total."); event.target.value = ""; setReceiptFiles([]); return; } setReceiptFiles(files); setReceiptError(null); }}/></label>{receiptFiles.length ? <ul className="mt-3 space-y-1 text-xs text-slate-600">{receiptFiles.map((file, index) => <li key={`${file.name}-${index}`} className="flex justify-between gap-3"><span className="truncate">{file.name}</span><span className="shrink-0">{(file.size / (1024 * 1024)).toFixed(1)} MB</span></li>)}</ul> : <p className="mt-2 text-xs text-slate-500">At least one invoice or supporting file is required.</p>}</div>
          <div className="space-y-3"><div className="flex items-center justify-between"><div><h3 className="font-bold text-slate-900">Products on this invoice</h3><p className="mt-1 text-xs text-slate-500">All products are available below. Category follows the selected product; imported products may be listed as Other.</p></div><button type="button" onClick={addReceiptLine} className="rounded-lg border border-emerald-200 px-3 py-2 text-sm font-bold text-emerald-800">+ Add product</button></div>
            {receiptLines.map((line, index) => <div key={line.id} className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 xl:grid-cols-[2fr_1.2fr_0.8fr_0.8fr_1.2fr_auto]"><label className="text-xs font-semibold text-slate-700">Category<select className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700" value={line.category} required onChange={(event) => updateReceiptLine(line.id, "category", event.target.value)}><option value="">Choose category</option><option value="noodles">Noodles</option><option value="cookies">Cookies</option><option value="rte">RTE</option><option value="other">Other</option></select></label><label className="text-xs font-semibold text-slate-700">Product<select className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700" value={line.productId} onChange={(event) => updateReceiptLine(line.id, "productId", event.target.value)} required><option value="">Choose product</option>{initialData.products.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.sku}</option>)}</select></label><label className="text-xs font-semibold text-slate-700">Batch code<input className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700" value={line.batchNumber} onChange={(event) => updateReceiptLine(line.id, "batchNumber", event.target.value)} required/></label><label className="text-xs font-semibold text-slate-700">Quantity<input className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700" type="number" min="1" step="1" value={line.receivedQuantity} onChange={(event) => updateReceiptLine(line.id, "receivedQuantity", event.target.value)} required/></label><label className="text-xs font-semibold text-slate-700">Damaged<input className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700" type="number" min="0" max={line.receivedQuantity || undefined} step="1" value={line.damagedQuantity} onChange={(event) => updateReceiptLine(line.id, "damagedQuantity", event.target.value)} required/></label><label className="text-xs font-semibold text-slate-700">Expiry date<input className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-700" type="date" value={line.expiryDate} onChange={(event) => updateReceiptLine(line.id, "expiryDate", event.target.value)} required/></label><div className="flex items-end justify-between gap-2"><span className="pb-3 text-xs font-semibold text-slate-500">Item {index + 1}</span>{receiptLines.length > 1 ? <button type="button" onClick={() => removeReceiptLine(line.id)} className="mb-1 rounded-lg px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50">Remove</button> : null}</div><p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900 sm:col-span-2 xl:col-span-6">Usable individual units are always split 40% Online, 40% Retail, and 20% Buffer. A Shopify listing is created or linked when needed.</p></div>)}
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
            <h3 className="font-bold text-slate-900">Shopify, retail and buffer allocation</h3>
            <p className="mt-1 text-sm text-slate-500">Every receipt uses the 40% Online, 40% Retail, 20% Buffer split. Whole units are rounded; the remainder goes to Buffer.</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-rose-200 bg-white p-3.5"><p className="text-sm font-semibold text-slate-700">Damaged</p><p className="mt-2 text-3xl font-bold text-rose-800">{damagedQuantity}</p><p className="mt-1 text-xs text-slate-500">Excluded from saleable allocation</p></div>
              <div className="rounded-xl border border-emerald-200 bg-white p-3.5"><p className="text-sm font-semibold text-slate-700">Shopify</p><p className="mt-2 text-3xl font-bold text-emerald-800">{onlineQuantity}</p><p className="mt-1 text-xs text-slate-500">Base packets</p></div>
              <div className="rounded-xl border border-emerald-200 bg-white p-3.5"><p className="text-sm font-semibold text-slate-700">Retail</p><p className="mt-2 text-3xl font-bold text-emerald-800">{retailQuantity}</p><p className="mt-1 text-xs text-slate-500">Base packets</p></div>
              <div className="rounded-xl border border-amber-200 bg-white p-3.5"><p className="text-sm font-semibold text-slate-700">Buffer</p><p className="mt-2 text-3xl font-bold text-amber-800">{bufferQuantity}</p><p className="mt-1 text-xs text-slate-500">Protected packets</p></div>
            </div>
          </div>

          <div className="flex justify-end"><button type="submit" disabled={!initialData.products.length || !initialData.locations.length} className="h-12 rounded-xl bg-brand-primary px-7 text-base font-bold text-white shadow-sm transition hover:bg-emerald-950 disabled:cursor-not-allowed disabled:opacity-50">Review invoice →</button></div>
        </form> : null}

        {receiptStep === "review" && selectedLocation ? <div className="mx-auto max-w-2xl space-y-5">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"><strong>Please check carefully.</strong> Stock values cannot be silently edited after submission; corrections create another auditable transaction.</div>
          <ErrorMessage message={receiptError}/>
          <dl className="rounded-2xl border border-slate-200 px-5">
            <SummaryRow label="Date" value={receipt.receiptDate}/><SummaryRow label="Supplier" value={receipt.supplierName}/><SummaryRow label="Invoice" value={receipt.referenceId}/><SummaryRow label="Invoice value" value={`₹${receipt.invoiceValue || "0.00"}`}/><SummaryRow label="Location" value={selectedLocation.name}/><SummaryRow label="Total received" value={`${receivedQuantity} units`} strong/>
            {receiptAllocations.map(({ line, receivedQuantity: qty, damagedQuantity: damaged }) => <SummaryRow key={line.id} label={initialData.products.find((product) => product.id === line.productId)?.name ?? "Product"} value={`${qty} received · ${damaged} damaged · Batch ${line.batchNumber} · Expiry ${line.expiryDate || "—"}`}/>)}
            <SummaryRow label="Shopify / Retail / Buffer / Damaged" value={`${onlineQuantity} / ${retailQuantity} / ${bufferQuantity} / ${damagedQuantity} units`}/>
          </dl>
          <p className="text-center text-xs text-slate-500">Submitting as <strong>{user.username}</strong>. The Online allocation will be sent to Shopify automatically.</p>
          <div className="grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setReceiptStep("edit")} disabled={submitting} className="h-12 rounded-xl border border-slate-300 bg-white font-bold text-slate-700 hover:bg-slate-50">← Go back and edit</button><button type="button" onClick={submitReceipt} disabled={submitting} className="h-12 rounded-xl bg-brand-primary font-bold text-white hover:bg-emerald-950 disabled:opacity-60">{submitting ? "Saving and syncing…" : "Add invoice and update stock"}</button></div>
        </div> : null}

        {receiptStep === "success" && receiptSuccess && selectedLocation ? <div className="mx-auto max-w-2xl text-center">
          <div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-100 text-3xl font-bold text-emerald-800">✓</div><h3 className="mt-4 text-2xl font-bold text-slate-950">{receiptSuccess.receivedQuantity} units added</h3><p className="mt-2 text-sm text-slate-500">The inventory ledger and database were updated.</p>
          <dl className="mt-6 rounded-2xl border border-slate-200 px-5 text-left"><SummaryRow label="Supplier" value={receipt.supplierName}/><SummaryRow label="Invoice" value={receipt.referenceId}/><SummaryRow label="Products" value={receiptLines.length}/><SummaryRow label="Location" value={selectedLocation.name}/><SummaryRow label="Shopify / Retail / Buffer / Damaged" value={`${onlineQuantity} / ${retailQuantity} / ${bufferQuantity} / ${damagedQuantity}`}/><SummaryRow label="Transaction" value={receiptSuccess.transactionNumber}/><SummaryRow label="Submitted by" value={user.username}/>{receiptSuccess.shopifySync === "succeeded" ? <SummaryRow label="Shopify" value={<span className="text-emerald-700">Synced automatically ✓</span>}/> : null}{receiptSuccess.shopifySync === "pending" ? <SummaryRow label="Shopify" value={<span className="text-amber-700">Automatic retry queued</span>}/> : null}{receiptSuccess.shopifySync === "failed" ? <SummaryRow label="Shopify" value={<span className="text-rose-700">Needs administrator attention</span>}/> : null}</dl>
          {receiptAttachmentLinks.length ? <div className="mt-4 rounded-xl border border-slate-200 p-4 text-left"><p className="text-sm font-bold text-slate-800">Invoice files</p><ul className="mt-2 space-y-2">{receiptAttachmentLinks.map((file) => <li key={file.id}><a className="text-sm font-semibold text-emerald-800 underline" href={file.url}>{file.fileName} · Download</a></li>)}</ul></div> : null}
          <div className="mt-6 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => changePanel("activity")} className="h-12 rounded-xl border border-slate-300 font-bold text-slate-700">View my updates</button><button type="button" onClick={startAnotherReceipt} className="h-12 rounded-xl bg-brand-primary font-bold text-white">Receive more stock</button></div>
        </div> : null}
      </div>
    </section> : null}

    {panel === "dispatch" ? <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-7"><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">{dispatchStep === "edit" ? "Step 1 of 2 · Enter" : dispatchStep === "review" ? "Step 2 of 2 · Review" : "Completed"}</p><h2 className="mt-1 text-xl font-bold text-slate-950">{dispatchStep === "success" ? "Retail dispatch saved" : "Dispatch retail stock"}</h2><p className="mt-1 text-sm text-slate-500">Record individual packets leaving the warehouse for offline retail orders.</p></div>
      <div className="p-5 sm:p-7">
        {dispatchStep === "edit" ? <form className="space-y-6" onSubmit={reviewDispatch}>
          <ErrorMessage message={dispatchError}/>
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Date"><input className={inputClass} type="date" value={dispatch.deliveryDate} onChange={(event) => updateDispatch("deliveryDate", event.target.value)} required/></Field>
            <Field label="Order type"><select className={inputClass} value={dispatch.orderType} onChange={(event) => updateDispatch("orderType", event.target.value as DispatchDraft["orderType"])} required><option value="retail">Retail</option><option value="sample">Sample</option><option value="inhand">Inhand</option><option value="other">Other</option></select></Field>
            <Field label="Invoice number"><input className={inputClass} value={dispatch.referenceId} onChange={(event) => updateDispatch("referenceId", event.target.value)} placeholder="Example: INV-1042" maxLength={100} required/></Field>
            <Field label="Order / invoice value (₹)"><input className={inputClass} type="number" min="0.01" step="0.01" value={dispatch.orderValue} onChange={(event) => updateDispatch("orderValue", event.target.value)} placeholder="0.00" required/></Field>
            <Field label="Customer name"><input className={inputClass} value={dispatch.destination} onChange={(event) => updateDispatch("destination", event.target.value)} placeholder="Customer or store" maxLength={200} required/></Field>
            <Field label="Location"><input className={inputClass} value={dispatch.destination} onChange={(event) => updateDispatch("destination", event.target.value)} placeholder="Delivery location" maxLength={200} required/></Field>
            <Field label="Warehouse"><select className={inputClass} value={dispatch.warehouseLocationId} onChange={(event) => updateDispatch("warehouseLocationId", event.target.value)} required><option value="">Choose warehouse</option>{initialData.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></Field>
            <Field label="Delivery status"><select className={inputClass} value={dispatch.deliveryStatus} onChange={(event) => updateDispatch("deliveryStatus", event.target.value as DispatchDraft["deliveryStatus"])} required><option value="packing">Packing</option><option value="shipped">Shipped</option><option value="dispatched">Dispatched</option><option value="delivered">Delivered</option></select></Field>
            <Field label="Delivery partner"><input className={inputClass} value={dispatch.deliveryPartner} onChange={(event) => updateDispatch("deliveryPartner", event.target.value)} placeholder="Courier / transporter" maxLength={160} required/></Field>
            <Field label="Delivery cost (₹)"><input className={inputClass} type="number" min="0" step="0.01" value={dispatch.deliveryCost} onChange={(event) => updateDispatch("deliveryCost", event.target.value)} placeholder="0.00" required/></Field>
            <Field label="LR number"><input className={inputClass} value={dispatch.lrNumber} onChange={(event) => updateDispatch("lrNumber", event.target.value)} maxLength={100} required/></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {([ ["invoiceFile", "Invoice upload"], ["acknowledgementFile", "Acknowledgement upload"] ] as const).map(([key, label]) => <Field key={key} label={label} hint="Required · PDF, JPG, PNG, or WebP · up to 3 MB each"><input className="block min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-100 file:px-4 file:py-2 file:text-sm file:font-bold file:text-emerald-900" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required onChange={(event) => { const file = event.target.files?.[0] ?? null; updateDispatchFile(key, file); }}/></Field>)}
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-4"><div><h3 className="font-bold text-slate-900">Packets being dispatched</h3><p className="mt-1 text-xs text-slate-500">Use one line for each product. Quantities are individual packets.</p></div><span className="rounded-full bg-emerald-100 px-3 py-1.5 text-sm font-bold text-emerald-800">Total {dispatchTotal}</span></div>
            <div className="mt-5 space-y-3">{dispatch.lines.map((line, index) => {
              const available = dispatchAvailable(line.productId);
              return <div key={line.id} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(9rem,0.25fr)_minmax(11rem,0.3fr)] sm:items-end lg:grid-cols-[2.5rem_minmax(0,1fr)_minmax(10rem,0.22fr)_minmax(12rem,0.28fr)_9rem] lg:gap-4">
                <span className="hidden size-9 place-self-center place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-600 sm:grid">{index + 1}</span>
                <Field label="Product"><select className={inputClass} value={line.productId} onChange={(event) => updateDispatchLine(line.id, "productId", event.target.value)} required><option value="">Choose product</option>{initialData.products.map((product) => <option key={product.id} value={product.id}>{product.name} — {product.sku}</option>)}</select></Field>
                <Field label="Packets" hint={line.productId ? `${available} total units available across Retail, Buffer, and Online` : "Select a product"}><input className={inputClass} type="number" inputMode="numeric" min="1" step="1" max={line.productId ? available : undefined} value={line.quantity} onChange={(event) => updateDispatchLine(line.id, "quantity", event.target.value)} placeholder="0" required/></Field>
                <Field label="Unit sale price (₹)"><input className={inputClass} type="number" min="0.01" step="0.01" value={line.unitPrice} onChange={(event) => updateDispatchLine(line.id, "unitPrice", event.target.value)} placeholder="0.00" required/></Field>
                <button type="button" onClick={() => removeDispatchLine(line.id)} disabled={dispatch.lines.length === 1} className="h-12 rounded-xl border border-slate-300 px-4 text-sm font-bold text-slate-600 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-40 sm:col-start-2 lg:col-start-auto" aria-label={`Remove product line ${index + 1}`}>Remove</button>
              </div>;
            })}</div>
            <button type="button" onClick={addDispatchLine} disabled={dispatch.lines.length >= 50} className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-800 disabled:opacity-50">+ Add another product</button>
          </div>
          <Field label="Notes" hint="Optional: transporter, vehicle, or delivery instructions."><textarea className="min-h-24 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-base text-slate-900 outline-none transition focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100" value={dispatch.notes} onChange={(event) => updateDispatch("notes", event.target.value)} maxLength={500}/></Field>
          <div className="flex justify-end"><button type="submit" disabled={!initialData.products.length || !initialData.locations.length} className="h-12 rounded-xl bg-brand-primary px-7 text-base font-bold text-white disabled:opacity-50">Review outward stock →</button></div>
        </form> : null}

        {dispatchStep === "review" && dispatchLocation ? <div className="mx-auto max-w-3xl space-y-5">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"><strong>Please check every packet count.</strong> Any Retail shortfall moves from Buffer first, then Online. The transfer and dispatch are recorded in the ledger.</div>
          <ErrorMessage message={dispatchError}/>
          <dl className="rounded-2xl border border-slate-200 px-5"><SummaryRow label="Date" value={dispatch.deliveryDate}/><SummaryRow label="Order type" value={dispatch.orderType}/><SummaryRow label="Customer / location" value={dispatch.destination}/><SummaryRow label="Invoice" value={dispatch.referenceId}/><SummaryRow label="Order value" value={`₹${dispatch.orderValue}`}/><SummaryRow label="Status" value={dispatch.deliveryStatus}/><SummaryRow label="Delivery partner / cost" value={`${dispatch.deliveryPartner} · ₹${dispatch.deliveryCost}`}/><SummaryRow label="LR number" value={dispatch.lrNumber}/><SummaryRow label="Warehouse" value={dispatchLocation.name}/><SummaryRow label="Total outward stock" value={`${dispatchTotal} packets`} strong/></dl>
          <div className="overflow-x-auto rounded-2xl border border-slate-200"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Product</th><th className="px-4 py-3">SKU</th><th className="px-4 py-3 text-right">Dispatch</th><th className="px-4 py-3 text-right">Move Buffer → Retail</th><th className="px-4 py-3 text-right">Move Online → Retail</th></tr></thead><tbody>{dispatch.lines.map((line) => { const product = initialData.products.find((item) => item.id === line.productId); const amount = quantity(line.quantity); const movement = dispatchMovement(line.productId, amount); return <tr key={line.id} className="border-t border-slate-100"><td className="px-4 py-3 font-semibold text-slate-900">{product?.name}</td><td className="px-4 py-3 text-slate-500">{product?.sku}</td><td className="px-4 py-3 text-right font-bold">{amount}</td><td className="px-4 py-3 text-right text-slate-600">{movement.movedFromBuffer}</td><td className="px-4 py-3 text-right text-slate-600">{movement.movedFromOnline}</td></tr>; })}</tbody></table></div>
          <p className="text-center text-xs text-slate-500">Submitting as <strong>{user.username}</strong></p>
          <div className="grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setDispatchStep("edit")} disabled={submitting} className="h-12 rounded-xl border border-slate-300 bg-white font-bold text-slate-700">← Go back and edit</button><button type="button" onClick={submitDispatch} disabled={submitting} className="h-12 rounded-xl bg-brand-primary font-bold text-white disabled:opacity-60">{submitting ? "Saving dispatch…" : `Submit ${dispatchTotal} packets outward`}</button></div>
        </div> : null}

        {dispatchStep === "success" && dispatchSuccess ? <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-100 text-3xl font-bold text-emerald-800">✓</div><h3 className="mt-4 text-2xl font-bold text-slate-950">{dispatchSuccess.totalQuantity} packets dispatched</h3><p className="mt-2 text-sm text-slate-500">Transfers into Retail and the dispatch were recorded in the inventory ledger.</p>
          <dl className="mt-6 rounded-2xl border border-slate-200 px-5 text-left"><SummaryRow label="Sent to" value={dispatchSuccess.destination}/><SummaryRow label="Reference" value={dispatch.referenceId}/><SummaryRow label="Transaction" value={dispatchSuccess.transactionNumber}/><SummaryRow label="Submitted by" value={user.username}/></dl>
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left text-sm text-emerald-950">Shopify sync: <strong>{dispatchSuccess.shopifySync.replaceAll("_", " ")}</strong>{dispatchSuccess.stockTransferTransactionId ? ` · Transfer ${dispatchSuccess.stockTransferTransactionId}` : " · No Online stock was moved"}</div>
          <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-200 text-left"><table className="w-full min-w-[700px] text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Product</th><th className="px-4 py-3">SKU</th><th className="px-4 py-3 text-right">Sent</th><th className="px-4 py-3 text-right">Buffer → Retail</th><th className="px-4 py-3 text-right">Online → Retail</th><th className="px-4 py-3 text-right">Retail after</th></tr></thead><tbody>{dispatchSuccess.lines.map((line) => <tr key={line.productId} className="border-t border-slate-100"><td className="px-4 py-3 font-semibold text-slate-900">{line.productName}</td><td className="px-4 py-3 text-slate-500">{line.sku}</td><td className="px-4 py-3 text-right font-bold">{line.quantity}</td><td className="px-4 py-3 text-right">{line.movedFromBuffer}</td><td className="px-4 py-3 text-right">{line.movedFromOnline}</td><td className="px-4 py-3 text-right">{line.closingRetailBalance}</td></tr>)}</tbody></table></div>
          {dispatchDocumentLinks.length ? <div className="mt-4 rounded-xl border border-slate-200 p-4 text-left"><p className="text-sm font-bold text-slate-800">Delivery documents</p><ul className="mt-2 space-y-2">{dispatchDocumentLinks.map((file) => <li key={file.id}><a className="text-sm font-semibold text-emerald-800 underline" href={file.url}>{file.fileName} · Download</a></li>)}</ul></div> : null}
          <div className="mt-6 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => changePanel("activity")} className="h-12 rounded-xl border border-slate-300 font-bold text-slate-700">View my updates</button><button type="button" onClick={startAnotherDispatch} className="h-12 rounded-xl bg-brand-primary font-bold text-white">Create another dispatch</button></div>
        </div> : null}
      </div>
    </section> : null}

    {panel === "stock-condition" ? <WarehouseStockCondition data={initialData} onDispose={() => changePanel("disposal")}/> : null}

    {panel === "returns" ? <WarehouseReturnDisposal kind="return" products={initialData.products} locations={initialData.locations} balances={initialData.balances} expiries={initialData.expiries} userRole={user.role}/> : null}
    {panel === "disposal" ? <WarehouseReturnDisposal kind="disposal" onManageStock={() => changePanel("stock-condition")} products={initialData.products} locations={initialData.locations} balances={initialData.balances} expiries={initialData.expiries} userRole={user.role}/> : null}

    {panel === "product" ? <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-7"><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">{productStep === "edit" ? "Step 1 of 2 · Enter" : productStep === "review" ? "Step 2 of 2 · Review" : "Completed"}</p><h2 className="mt-1 text-xl font-bold text-slate-950">{productStep === "success" ? "Product created successfully" : "Add a new product"}</h2><p className="mt-1 text-sm text-slate-500">Use this only when the SKU is not already in the product list.</p></div>
      <div className="p-5 sm:p-7">
        {productStep === "edit" ? <form className="mx-auto max-w-2xl space-y-5" onSubmit={reviewProduct}><ErrorMessage message={productError}/><Field label="Product name" hint="Use the name printed on the product."><input className={inputClass} value={product.name} onChange={(event) => updateProduct("name", event.target.value)} placeholder="Example: Millet Noodles Classic" required/></Field><div className="grid gap-5 sm:grid-cols-2"><Field label="SKU" hint="Must be unique."><input className={`${inputClass} uppercase`} value={product.sku} onChange={(event) => updateProduct("sku", event.target.value)} placeholder="Example: MN-CLASSIC-180" required/></Field><Field label="Product category"><select className={inputClass} value={product.category} onChange={(event) => updateProduct("category", event.target.value as ProductDraft["category"])}><option value="noodles">Noodles</option><option value="cookies">Cookies</option><option value="rte">RTE</option><option value="other">Other</option></select></Field><Field label="Fixed unit price (₹)"><input className={inputClass} type="number" min="0" step="0.01" value={product.unitPrice} onChange={(event) => updateProduct("unitPrice", event.target.value)}/></Field><Field label="Pack size"><input className={inputClass} value={product.packSize} onChange={(event) => updateProduct("packSize", event.target.value)} placeholder="Example: 180 g"/></Field></div><Field label="Barcode" hint="Optional. Scan or type the number if available."><input className={inputClass} value={product.barcode} onChange={(event) => updateProduct("barcode", event.target.value)} placeholder="Optional barcode"/></Field><label className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900"><input type="checkbox" className="mt-1 size-4 accent-emerald-700" checked={addToShopify} onChange={(event) => setAddToShopify(event.target.checked)}/><span><strong>Also add this product to Shopify</strong> to sell it online. New receipts are always split 40% Online, 40% Retail, and 20% Buffer. The product is linked to Shopify when its first stock is received. The unit price is used as the Shopify price.</span></label><div className="flex justify-end"><button type="submit" className="h-12 rounded-xl bg-brand-primary px-7 font-bold text-white">Review new product →</button></div></form> : null}
        {productStep === "review" ? <div className="mx-auto max-w-2xl space-y-5"><ErrorMessage message={productError}/><div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><strong>Check for duplicates</strong> before submitting, especially the product SKU.</div><dl className="rounded-2xl border border-slate-200 px-5"><SummaryRow label="Product name" value={product.name}/><SummaryRow label="SKU" value={product.sku.trim().toUpperCase()} strong/><SummaryRow label="Pack size" value={product.packSize || "Not entered"}/><SummaryRow label="Barcode" value={product.barcode || "Not entered"}/><SummaryRow label="Sell on Shopify" value={addToShopify ? "Yes, add to Shopify" : "No, retail only"}/><SummaryRow label="Submitted by" value={user.username}/></dl><div className="grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setProductStep("edit")} disabled={submitting} className="h-12 rounded-xl border border-slate-300 font-bold text-slate-700">← Go back and edit</button><button type="button" onClick={submitProduct} disabled={submitting} className="h-12 rounded-xl bg-brand-primary font-bold text-white disabled:opacity-60">{submitting ? "Creating…" : "Create product in database"}</button></div></div> : null}
        {productStep === "success" && createdProduct ? <div className="mx-auto max-w-2xl text-center"><div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-100 text-3xl font-bold text-emerald-800">✓</div><h3 className="mt-4 text-2xl font-bold text-slate-950">Product added</h3><p className="mt-2 text-sm text-slate-500">It is now available in the warehouse product list.</p><dl className="mt-6 rounded-2xl border border-slate-200 px-5 text-left"><SummaryRow label="Product" value={createdProduct.name}/><SummaryRow label="SKU" value={createdProduct.sku} strong/><SummaryRow label="Pack size" value={createdProduct.packSize || "Not entered"}/><SummaryRow label="Shopify" value={createdShopifyStatus}/><SummaryRow label="Created by" value={user.username}/></dl><div className="mt-6 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => changePanel("activity")} className="h-12 rounded-xl border border-slate-300 font-bold text-slate-700">View my updates</button><button type="button" onClick={() => { setProduct(EMPTY_PRODUCT); setCreatedProduct(null); setAddToShopify(false); setProductStep("edit"); }} className="h-12 rounded-xl bg-brand-primary font-bold text-white">Add another product</button></div></div> : null}
      </div>
    </section> : null}

    {panel === "activity" ? <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-7"><h2 className="text-xl font-bold text-slate-950">{canReviewWarehouseDisposals ? "Recent warehouse updates" : "My recent updates"}</h2><p className="mt-1 text-sm text-slate-500">{canReviewWarehouseDisposals ? "Recent warehouse disposals include their manager approval proof." : <>Only entries submitted under <strong>{user.username}</strong> are shown.</>}</p></div>
      <div className="p-5 sm:p-7"><div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div className="rounded-xl bg-emerald-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Stock receipts shown</p><p className="mt-1 text-2xl font-bold text-emerald-950">{activityCounts.receipts}</p></div><div className="rounded-xl bg-emerald-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Retail dispatches shown</p><p className="mt-1 text-2xl font-bold text-emerald-950">{activityCounts.dispatches}</p></div><div className="rounded-xl bg-amber-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Stock transfers shown</p><p className="mt-1 text-2xl font-bold text-amber-950">{activityCounts.transfers}</p></div><div className="rounded-xl bg-sky-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-sky-700">Products created shown</p><p className="mt-1 text-2xl font-bold text-sky-950">{activityCounts.products}</p></div></div>
        {initialData.activities.length ? <div className="space-y-3">{initialData.activities.map((activity) => <article key={activity.id} className="rounded-xl border border-slate-200 p-4 sm:flex sm:items-start sm:justify-between sm:gap-5"><div><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${activity.kind === "stock_received" ? "bg-emerald-100 text-emerald-800" : activity.kind === "retail_dispatched" ? "bg-emerald-100 text-emerald-800" : activity.kind === "stock_transferred" ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"}`}>{activity.kind === "stock_received" ? "Stock received" : activity.kind === "retail_dispatched" ? "Retail dispatched" : activity.kind === "stock_transferred" ? "Stock transferred" : activity.kind === "stock_disposed" ? "Stock disposed" : "Product created"}</span><span className="text-xs text-slate-400">{localDateTime(activity.occurredAt)}</span></div><h3 className="mt-2 font-bold text-slate-900">{activity.title}</h3><p className="mt-0.5 text-xs font-medium text-slate-500">{activity.reference}</p></div><div className="mt-3 flex max-w-xl flex-wrap gap-2 sm:mt-0 sm:justify-end">{activity.details.map((detail) => <span key={detail} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600">{detail}</span>)}{activity.documents?.map((document) => <a key={document.id} className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-800 underline" href={document.url}>{document.fileName} · Approval proof</a>)}</div></article>)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 py-14 text-center"><p className="font-bold text-slate-800">No updates yet</p><p className="mt-1 text-sm text-slate-500">Your submitted receipts, retail dispatches, transfers, and products will appear here.</p><button type="button" onClick={() => changePanel("receive")} className="mt-5 rounded-xl bg-brand-primary px-5 py-3 text-sm font-bold text-white">Receive first stock</button></div>}
      </div>
    </section> : null}
  </div>;
}
