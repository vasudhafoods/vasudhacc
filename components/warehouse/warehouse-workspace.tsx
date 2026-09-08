"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { WarehouseProductOption, WarehouseWorkspaceData } from "@/types/warehouse";

type Panel = "receive" | "product" | "activity";
type Step = "edit" | "review" | "success";

interface ReceiptDraft {
  productId: string;
  warehouseLocationId: string;
  batchNumber: string;
  source: string;
  referenceId: string;
  manufacturingDate: string;
  expiryDate: string;
  receivedQuantity: string;
  onlineQuantity: string;
  retailQuantity: string;
  damagedQuantity: string;
}

interface ProductDraft {
  sku: string;
  name: string;
  packSize: string;
  barcode: string;
}

interface ReceiptSuccess {
  transactionNumber: string;
  receivedQuantity: number;
  shopifySync: "not_required" | "pending";
}

const EMPTY_PRODUCT: ProductDraft = { sku: "", name: "", packSize: "", barcode: "" };

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
  user: { displayName: string; username: string };
  initialData: WarehouseWorkspaceData;
}) {
  const router = useRouter();
  const firstProduct = initialData.products[0]?.id ?? "";
  const firstLocation = initialData.locations[0]?.id ?? "";
  const [panel, setPanel] = useState<Panel>("receive");
  const [receiptStep, setReceiptStep] = useState<Step>("edit");
  const [productStep, setProductStep] = useState<Step>("edit");
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [receiptSuccess, setReceiptSuccess] = useState<ReceiptSuccess | null>(null);
  const [createdProduct, setCreatedProduct] = useState<WarehouseProductOption | null>(null);
  const [receipt, setReceipt] = useState<ReceiptDraft>({
    productId: firstProduct,
    warehouseLocationId: firstLocation,
    batchNumber: "",
    source: "Production / supplier delivery",
    referenceId: "",
    manufacturingDate: "",
    expiryDate: "",
    receivedQuantity: "",
    onlineQuantity: "0",
    retailQuantity: "0",
    damagedQuantity: "0",
  });
  const [product, setProduct] = useState<ProductDraft>(EMPTY_PRODUCT);

  const selectedProduct = initialData.products.find((item) => item.id === receipt.productId) ?? null;
  const selectedLocation = initialData.locations.find((item) => item.id === receipt.warehouseLocationId) ?? null;
  const receivedQuantity = quantity(receipt.receivedQuantity);
  const onlineQuantity = quantity(receipt.onlineQuantity);
  const retailQuantity = quantity(receipt.retailQuantity);
  const damagedQuantity = quantity(receipt.damagedQuantity);
  const bufferQuantity = receivedQuantity - onlineQuantity - retailQuantity - damagedQuantity;
  const wholeQuantities = [receivedQuantity, onlineQuantity, retailQuantity, damagedQuantity, bufferQuantity].every(Number.isSafeInteger);

  const activityCounts = useMemo(() => ({
    receipts: initialData.activities.filter((activity) => activity.kind === "stock_received").length,
    products: initialData.activities.filter((activity) => activity.kind === "product_created").length,
  }), [initialData.activities]);

  function updateReceipt<K extends keyof ReceiptDraft>(key: K, value: ReceiptDraft[K]) {
    setReceipt((current) => ({ ...current, [key]: value }));
    setReceiptError(null);
  }

  function updateProduct<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) {
    setProduct((current) => ({ ...current, [key]: value }));
    setProductError(null);
  }

  function reviewReceipt(event: FormEvent) {
    event.preventDefault();
    if (!selectedProduct) return setReceiptError("Select a product.");
    if (!selectedLocation) return setReceiptError("Select a warehouse location.");
    if (!receipt.batchNumber.trim()) return setReceiptError("Enter the batch number printed on the stock.");
    if (!wholeQuantities || receivedQuantity <= 0 || onlineQuantity < 0 || retailQuantity < 0 || damagedQuantity < 0) return setReceiptError("All quantities must be positive whole numbers, and total received must be greater than zero.");
    if (bufferQuantity < 0) return setReceiptError("Online, retail, and damaged stock are more than the total received. Reduce one of those values.");
    if (onlineQuantity > 0 && !selectedProduct.shopifyMappingId) return setReceiptError("This product is not linked to Shopify yet. Keep Online stock at 0 and allocate it to Retail or Buffer.");
    if (receipt.manufacturingDate && receipt.expiryDate && receipt.expiryDate < receipt.manufacturingDate) return setReceiptError("Expiry date cannot be before the manufacturing date.");
    setReceiptError(null);
    setIdempotencyKey(crypto.randomUUID());
    setReceiptStep("review");
  }

  async function submitReceipt() {
    if (!selectedProduct || !selectedLocation || !idempotencyKey) return;
    setSubmitting(true);
    setReceiptError(null);
    try {
      const response = await fetch("/api/warehouse/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          ...receipt,
          receivedQuantity,
          onlineQuantity,
          retailQuantity,
          damagedQuantity,
          bufferQuantity,
          shopifyMappingId: onlineQuantity > 0 ? selectedProduct.shopifyMappingId : undefined,
        }),
      });
      const body = await response.json() as { result?: ReceiptSuccess; error?: { message?: string } };
      if (!response.ok || !body.result) throw new Error(body.error?.message ?? "Stock could not be submitted.");
      setReceiptSuccess(body.result);
      setReceiptStep("success");
      router.refresh();
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : "Stock could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  function startAnotherReceipt() {
    setReceipt((current) => ({
      ...current,
      batchNumber: "",
      referenceId: "",
      manufacturingDate: "",
      expiryDate: "",
      receivedQuantity: "",
      onlineQuantity: "0",
      retailQuantity: "0",
      damagedQuantity: "0",
    }));
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
    setProductError(null);
  }

  const inputClass = "h-12 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 outline-none transition focus:border-emerald-700 focus:ring-4 focus:ring-emerald-100";

  return <div className="space-y-6 pb-12">
    <section className="rounded-2xl bg-[#174f40] px-5 py-6 text-white shadow-sm sm:px-7">
      <p className="text-xs font-semibold uppercase tracking-[.16em] text-emerald-200">Warehouse desk</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Hello, {user.displayName}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-50">Choose one task below. Nothing changes until you review the summary and press the final Submit button.</p>
    </section>

    <nav className="grid gap-3 sm:grid-cols-3" aria-label="Warehouse tasks">
      {([
        ["receive", "1", "Receive stock", "Enter a new delivery"],
        ["product", "2", "Add new product", "Create a product record"],
        ["activity", "3", "My updates", "Check what you submitted"],
      ] as const).map(([key, number, title, subtitle]) => <button key={key} type="button" onClick={() => changePanel(key)} className={`flex min-h-20 items-center gap-3 rounded-2xl border p-4 text-left transition ${panel === key ? "border-emerald-700 bg-emerald-50 ring-2 ring-emerald-100" : "border-slate-200 bg-white hover:border-emerald-300"}`}>
        <span className={`grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold ${panel === key ? "bg-[#174f40] text-white" : "bg-slate-100 text-slate-600"}`}>{number}</span>
        <span><span className="block text-sm font-bold text-slate-900">{title}</span><span className="mt-0.5 block text-xs text-slate-500">{subtitle}</span></span>
      </button>)}
    </nav>

    {panel === "receive" ? <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-7"><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">{receiptStep === "edit" ? "Step 1 of 2 · Enter" : receiptStep === "review" ? "Step 2 of 2 · Review" : "Completed"}</p><h2 className="mt-1 text-xl font-bold text-slate-950">{receiptStep === "success" ? "Stock submitted successfully" : "Receive new stock"}</h2></div>
      <div className="p-5 sm:p-7">
        {receiptStep === "edit" ? <form className="space-y-6" onSubmit={reviewReceipt}>
          <ErrorMessage message={receiptError}/>
          {!initialData.products.length || !initialData.locations.length ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">{!initialData.products.length ? "No active products are available. Add a product first. " : ""}{!initialData.locations.length ? "No warehouse location is configured. Ask an administrator to configure one." : ""}</div> : null}
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Product"><select className={inputClass} value={receipt.productId} onChange={(event) => { updateReceipt("productId", event.target.value); updateReceipt("onlineQuantity", "0"); }} required><option value="">Choose product</option>{initialData.products.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.sku}</option>)}</select></Field>
            <Field label="Warehouse location"><select className={inputClass} value={receipt.warehouseLocationId} onChange={(event) => updateReceipt("warehouseLocationId", event.target.value)} required><option value="">Choose location</option>{initialData.locations.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}</select></Field>
            <Field label="Batch number" hint="Enter exactly as printed on the carton or pouch."><input className={inputClass} value={receipt.batchNumber} onChange={(event) => updateReceipt("batchNumber", event.target.value)} placeholder="Example: MIL-260908-A" required/></Field>
            <Field label="Total units received"><input className={inputClass} type="number" inputMode="numeric" min="1" step="1" value={receipt.receivedQuantity} onChange={(event) => updateReceipt("receivedQuantity", event.target.value)} placeholder="0" required/></Field>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
            <h3 className="font-bold text-slate-900">Where should this stock go?</h3>
            <p className="mt-1 text-sm text-slate-500">Enter Online, Retail, and Damaged. The remaining units automatically go to Buffer.</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Online" hint={selectedProduct?.shopifyMappingId ? "Will be queued for Shopify sync." : "Not linked to Shopify; keep at 0."}><input className={inputClass} type="number" inputMode="numeric" min="0" step="1" value={receipt.onlineQuantity} disabled={!selectedProduct?.shopifyMappingId} onChange={(event) => updateReceipt("onlineQuantity", event.target.value)}/></Field>
              <Field label="Retail"><input className={inputClass} type="number" inputMode="numeric" min="0" step="1" value={receipt.retailQuantity} onChange={(event) => updateReceipt("retailQuantity", event.target.value)}/></Field>
              <Field label="Damaged / rejected"><input className={inputClass} type="number" inputMode="numeric" min="0" step="1" value={receipt.damagedQuantity} onChange={(event) => updateReceipt("damagedQuantity", event.target.value)}/></Field>
              <div className={`rounded-xl border p-3.5 ${bufferQuantity < 0 ? "border-rose-300 bg-rose-50" : "border-emerald-200 bg-white"}`}><p className="text-sm font-semibold text-slate-700">Buffer (automatic)</p><p className={`mt-2 text-3xl font-bold ${bufferQuantity < 0 ? "text-rose-700" : "text-emerald-800"}`}>{Number.isFinite(bufferQuantity) ? bufferQuantity : 0}</p><p className="mt-1 text-xs text-slate-500">Remaining protected stock</p></div>
            </div>
          </div>

          <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer text-sm font-bold text-slate-800">Optional delivery details</summary><div className="mt-5 grid gap-5 md:grid-cols-2">
            <Field label="Manufacturing date"><input className={inputClass} type="date" value={receipt.manufacturingDate} onChange={(event) => updateReceipt("manufacturingDate", event.target.value)}/></Field>
            <Field label="Expiry date"><input className={inputClass} type="date" value={receipt.expiryDate} onChange={(event) => updateReceipt("expiryDate", event.target.value)}/></Field>
            <Field label="Received from"><input className={inputClass} value={receipt.source} onChange={(event) => updateReceipt("source", event.target.value)} placeholder="Production / supplier delivery"/></Field>
            <Field label="Invoice or reference number"><input className={inputClass} value={receipt.referenceId} onChange={(event) => updateReceipt("referenceId", event.target.value)} placeholder="Optional"/></Field>
          </div></details>
          <div className="flex justify-end"><button type="submit" disabled={!initialData.products.length || !initialData.locations.length} className="h-12 rounded-xl bg-[#174f40] px-7 text-base font-bold text-white shadow-sm transition hover:bg-[#123f34] disabled:cursor-not-allowed disabled:opacity-50">Review stock entry →</button></div>
        </form> : null}

        {receiptStep === "review" && selectedProduct && selectedLocation ? <div className="mx-auto max-w-2xl space-y-5">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"><strong>Please check carefully.</strong> Stock values cannot be silently edited after submission; corrections create another auditable transaction.</div>
          <ErrorMessage message={receiptError}/>
          <dl className="rounded-2xl border border-slate-200 px-5">
            <SummaryRow label="Product" value={<>{selectedProduct.name}<span className="block text-xs font-normal text-slate-500">{selectedProduct.sku}</span></>}/>
            <SummaryRow label="Location" value={selectedLocation.name}/><SummaryRow label="Batch" value={receipt.batchNumber}/><SummaryRow label="Total received" value={`${receivedQuantity} units`} strong/>
            <SummaryRow label="Online" value={`${onlineQuantity} units`}/><SummaryRow label="Retail" value={`${retailQuantity} units`}/><SummaryRow label="Buffer" value={`${bufferQuantity} units`}/><SummaryRow label="Damaged / rejected" value={`${damagedQuantity} units`}/>
            {receipt.referenceId ? <SummaryRow label="Reference" value={receipt.referenceId}/> : null}
          </dl>
          <p className="text-center text-xs text-slate-500">Submitting as <strong>{user.username}</strong></p>
          <div className="grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setReceiptStep("edit")} disabled={submitting} className="h-12 rounded-xl border border-slate-300 bg-white font-bold text-slate-700 hover:bg-slate-50">← Go back and edit</button><button type="button" onClick={submitReceipt} disabled={submitting} className="h-12 rounded-xl bg-[#174f40] font-bold text-white hover:bg-[#123f34] disabled:opacity-60">{submitting ? "Submitting…" : "Submit stock to database"}</button></div>
        </div> : null}

        {receiptStep === "success" && receiptSuccess && selectedProduct && selectedLocation ? <div className="mx-auto max-w-2xl text-center">
          <div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-100 text-3xl font-bold text-emerald-800">✓</div><h3 className="mt-4 text-2xl font-bold text-slate-950">{receiptSuccess.receivedQuantity} units added</h3><p className="mt-2 text-sm text-slate-500">The inventory ledger and database were updated.</p>
          <dl className="mt-6 rounded-2xl border border-slate-200 px-5 text-left"><SummaryRow label="Product" value={selectedProduct.name}/><SummaryRow label="Location" value={selectedLocation.name}/><SummaryRow label="Batch" value={receipt.batchNumber}/><SummaryRow label="Online / Retail / Buffer / Damaged" value={`${onlineQuantity} / ${retailQuantity} / ${bufferQuantity} / ${damagedQuantity}`}/><SummaryRow label="Transaction" value={receiptSuccess.transactionNumber}/><SummaryRow label="Submitted by" value={user.username}/>{receiptSuccess.shopifySync === "pending" ? <SummaryRow label="Shopify" value="Sync queued"/> : null}</dl>
          <div className="mt-6 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => changePanel("activity")} className="h-12 rounded-xl border border-slate-300 font-bold text-slate-700">View my updates</button><button type="button" onClick={startAnotherReceipt} className="h-12 rounded-xl bg-[#174f40] font-bold text-white">Receive more stock</button></div>
        </div> : null}
      </div>
    </section> : null}

    {panel === "product" ? <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-7"><p className="text-xs font-semibold uppercase tracking-[.14em] text-emerald-700">{productStep === "edit" ? "Step 1 of 2 · Enter" : productStep === "review" ? "Step 2 of 2 · Review" : "Completed"}</p><h2 className="mt-1 text-xl font-bold text-slate-950">{productStep === "success" ? "Product created successfully" : "Add a new product"}</h2><p className="mt-1 text-sm text-slate-500">Use this only when the SKU is not already in the product list.</p></div>
      <div className="p-5 sm:p-7">
        {productStep === "edit" ? <form className="mx-auto max-w-2xl space-y-5" onSubmit={reviewProduct}><ErrorMessage message={productError}/><Field label="Product name" hint="Use the name printed on the product."><input className={inputClass} value={product.name} onChange={(event) => updateProduct("name", event.target.value)} placeholder="Example: Millet Noodles Classic" required/></Field><div className="grid gap-5 sm:grid-cols-2"><Field label="SKU" hint="Must be unique."><input className={`${inputClass} uppercase`} value={product.sku} onChange={(event) => updateProduct("sku", event.target.value)} placeholder="Example: MN-CLASSIC-180" required/></Field><Field label="Pack size"><input className={inputClass} value={product.packSize} onChange={(event) => updateProduct("packSize", event.target.value)} placeholder="Example: 180 g"/></Field></div><Field label="Barcode" hint="Optional. Scan or type the number if available."><input className={inputClass} value={product.barcode} onChange={(event) => updateProduct("barcode", event.target.value)} placeholder="Optional barcode"/></Field><div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900">Creating a product adds it to Neon. An administrator can connect it to the matching Shopify variant later; until then, warehouse staff can allocate its stock to Retail or Buffer.</div><div className="flex justify-end"><button type="submit" className="h-12 rounded-xl bg-[#174f40] px-7 font-bold text-white">Review new product →</button></div></form> : null}
        {productStep === "review" ? <div className="mx-auto max-w-2xl space-y-5"><ErrorMessage message={productError}/><div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><strong>Check for duplicates</strong> before submitting, especially the product SKU.</div><dl className="rounded-2xl border border-slate-200 px-5"><SummaryRow label="Product name" value={product.name}/><SummaryRow label="SKU" value={product.sku.trim().toUpperCase()} strong/><SummaryRow label="Pack size" value={product.packSize || "Not entered"}/><SummaryRow label="Barcode" value={product.barcode || "Not entered"}/><SummaryRow label="Submitted by" value={user.username}/></dl><div className="grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setProductStep("edit")} disabled={submitting} className="h-12 rounded-xl border border-slate-300 font-bold text-slate-700">← Go back and edit</button><button type="button" onClick={submitProduct} disabled={submitting} className="h-12 rounded-xl bg-[#174f40] font-bold text-white disabled:opacity-60">{submitting ? "Creating…" : "Create product in database"}</button></div></div> : null}
        {productStep === "success" && createdProduct ? <div className="mx-auto max-w-2xl text-center"><div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-100 text-3xl font-bold text-emerald-800">✓</div><h3 className="mt-4 text-2xl font-bold text-slate-950">Product added</h3><p className="mt-2 text-sm text-slate-500">It is now available in the warehouse product list.</p><dl className="mt-6 rounded-2xl border border-slate-200 px-5 text-left"><SummaryRow label="Product" value={createdProduct.name}/><SummaryRow label="SKU" value={createdProduct.sku} strong/><SummaryRow label="Pack size" value={createdProduct.packSize || "Not entered"}/><SummaryRow label="Shopify connection" value="Not linked yet"/><SummaryRow label="Created by" value={user.username}/></dl><div className="mt-6 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => changePanel("activity")} className="h-12 rounded-xl border border-slate-300 font-bold text-slate-700">View my updates</button><button type="button" onClick={() => { setProduct(EMPTY_PRODUCT); setCreatedProduct(null); setProductStep("edit"); }} className="h-12 rounded-xl bg-[#174f40] font-bold text-white">Add another product</button></div></div> : null}
      </div>
    </section> : null}

    {panel === "activity" ? <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-7"><h2 className="text-xl font-bold text-slate-950">My recent updates</h2><p className="mt-1 text-sm text-slate-500">Only entries submitted under <strong>{user.username}</strong> are shown.</p></div>
      <div className="p-5 sm:p-7"><div className="mb-5 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-emerald-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Stock receipts shown</p><p className="mt-1 text-2xl font-bold text-emerald-950">{activityCounts.receipts}</p></div><div className="rounded-xl bg-sky-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-sky-700">Products created shown</p><p className="mt-1 text-2xl font-bold text-sky-950">{activityCounts.products}</p></div></div>
        {initialData.activities.length ? <div className="space-y-3">{initialData.activities.map((activity) => <article key={activity.id} className="rounded-xl border border-slate-200 p-4 sm:flex sm:items-start sm:justify-between sm:gap-5"><div><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${activity.kind === "stock_received" ? "bg-emerald-100 text-emerald-800" : "bg-sky-100 text-sky-800"}`}>{activity.kind === "stock_received" ? "Stock received" : "Product created"}</span><span className="text-xs text-slate-400">{localDateTime(activity.occurredAt)}</span></div><h3 className="mt-2 font-bold text-slate-900">{activity.title}</h3><p className="mt-0.5 text-xs font-medium text-slate-500">{activity.reference}</p></div><div className="mt-3 flex max-w-xl flex-wrap gap-2 sm:mt-0 sm:justify-end">{activity.details.map((detail) => <span key={detail} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600">{detail}</span>)}</div></article>)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 py-14 text-center"><p className="font-bold text-slate-800">No updates yet</p><p className="mt-1 text-sm text-slate-500">Your submitted stock and products will appear here.</p><button type="button" onClick={() => changePanel("receive")} className="mt-5 rounded-xl bg-[#174f40] px-5 py-3 text-sm font-bold text-white">Receive first stock</button></div>}
      </div>
    </section> : null}
  </div>;
}
