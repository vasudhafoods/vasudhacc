import { inventoryBucket, type InventoryBucket } from "@/db/schema";
import { getDashboardSession, sessionHasRole } from "@/lib/auth/authorization";
import { disposeInventory, InventoryCommandError } from "@/services/inventory-ledger";
import { attemptStockMovementShopifySync } from "@/services/shopify-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WAREHOUSE_ACCESS = ["admin", "management", "warehouse_manager", "warehouse_staff"] as const;
const DISPOSAL_REASONS = ["expired", "damaged", "contaminated", "quality_rejected", "other"] as const;
const MAX_APPROVAL_PROOF_BYTES = 3 * 1024 * 1024;
const APPROVAL_PROOF_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

function isBucket(value: unknown): value is InventoryBucket {
  return typeof value === "string" && inventoryBucket.enumValues.includes(value as InventoryBucket);
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, { status: 401 });
  if (!sessionHasRole(session, WAREHOUSE_ACCESS)) return Response.json({ error: { code: "FORBIDDEN", message: "This account cannot dispose stock." } }, { status: 403 });

  try {
    let body: Record<string, unknown>;
    let proof: File | null = null;
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData();
      const payload = form.get("payload");
      if (typeof payload !== "string") return Response.json({ error: { code: "INVALID_DISPOSAL", message: "Disposal details are required." } }, { status: 400 });
      try {
        body = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return Response.json({ error: { code: "INVALID_DISPOSAL", message: "Disposal details are invalid." } }, { status: 400 });
      }
      const uploadedProof = form.get("approvalProof");
      if (uploadedProof instanceof File && uploadedProof.size > 0) proof = uploadedProof;
    } else {
      body = await request.json() as Record<string, unknown>;
    }
    if (session.role !== "admin" && !proof) return Response.json({ error: { code: "APPROVAL_REQUIRED", message: "Upload proof of manager approval before disposing stock." } }, { status: 400 });
    if (proof && proof.size > MAX_APPROVAL_PROOF_BYTES) return Response.json({ error: { code: "INVALID_APPROVAL_PROOF", message: "Manager approval proof must be 3 MB or smaller." } }, { status: 413 });
    if (proof && !APPROVAL_PROOF_TYPES.has(proof.type)) return Response.json({ error: { code: "INVALID_APPROVAL_PROOF", message: "Use a PDF, JPG, PNG, or WebP file for manager approval proof." } }, { status: 400 });
    if (!isBucket(body.sourceBucket)) return Response.json({ error: { code: "INVALID_DISPOSAL", message: "Select the stock bucket holding these packets." } }, { status: 400 });
    const disposalReason = DISPOSAL_REASONS.find((reason) => reason === body.disposalReason);
    if (!disposalReason) return Response.json({ error: { code: "INVALID_DISPOSAL", message: "Select a valid disposal reason." } }, { status: 400 });
    const expiryRaw = String(body.expiryDate ?? "");
    const expiryDate = new Date(`${expiryRaw}T12:00:00+05:30`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryRaw) || Number.isNaN(expiryDate.getTime())) throw new InventoryCommandError("INVALID_DISPOSAL", "Select a valid expiry date.");
    const result = await disposeInventory({
      productId: String(body.productId ?? ""),
      warehouseLocationId: String(body.warehouseLocationId ?? ""),
      sourceBucket: body.sourceBucket,
      quantity: Number(body.quantity),
      disposalReason,
      expiryDate,
      referenceId: String(body.referenceId ?? ""),
      notes: body.notes ? String(body.notes) : undefined,
      actorUsername: session.username,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      shopifyMappingId: body.shopifyMappingId ? String(body.shopifyMappingId) : undefined,
      approvalProof: proof ? {
        fileName: proof.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 220) || "manager-approval",
        contentType: proof.type,
        fileSize: proof.size,
        contentBase64: Buffer.from(await proof.arrayBuffer()).toString("base64"),
      } : undefined,
    });
    const shopifyTransactionId = result.stockRotationTransactionId ?? result.transactionId;
    const shopifySync = await attemptStockMovementShopifySync(shopifyTransactionId, result.transactionId, result.shopifySync);
    return Response.json({ ok: true, result: { ...result, shopifySync } }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InventoryCommandError) {
      const status = error.code === "INSUFFICIENT_STOCK" ? 409 : error.code === "NOT_FOUND" ? 404 : 400;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return Response.json({ error: { code: "DISPOSAL_FAILED", message: error instanceof Error ? error.message : "Stock disposal could not be recorded." } }, { status: 500 });
  }
}
