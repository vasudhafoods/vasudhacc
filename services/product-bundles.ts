import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { auditEvents, productBundleComponents, products } from "@/db/schema";
import { isBundleProduct, isPhysicalUnitProduct } from "@/lib/inventory/physical-units";

const MAX_COMPONENTS = 50;
const MAX_COMPONENT_QUANTITY = 1_000;

export class ProductBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductBundleError";
  }
}

export interface BundleComponent { productId: string; name: string; sku: string; quantity: number; }
export interface BundleRecipe { productId: string; name: string; sku: string; components: BundleComponent[]; }
export interface BundleSetup { bundles: BundleRecipe[]; units: { id: string; name: string; sku: string }[]; }

export async function readBundleSetup(): Promise<BundleSetup> {
  const db = getDatabase();
  const [catalog, recipes] = await Promise.all([
    db.select({ id: products.id, name: products.name, sku: products.sku }).from(products).where(eq(products.active, true)).orderBy(asc(products.name)),
    db.select({ bundleProductId: productBundleComponents.bundleProductId, productId: products.id, name: products.name, sku: products.sku, quantity: productBundleComponents.quantity })
      .from(productBundleComponents).innerJoin(products, eq(products.id, productBundleComponents.componentProductId)).orderBy(asc(products.name)),
  ]);
  const withRecipe = new Set(recipes.map((row) => row.bundleProductId));
  return {
    bundles: catalog.filter((product) => isBundleProduct(product.name) || withRecipe.has(product.id)).map((product) => ({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      components: recipes.filter((row) => row.bundleProductId === product.id).map(({ productId, name, sku, quantity }) => ({ productId, name, sku, quantity })),
    })),
    units: catalog.filter((product) => isPhysicalUnitProduct(product.name)),
  };
}

// Components of one combo unit, or an empty list when the product is not a configured combo.
export async function bundleComponents(bundleProductId: string): Promise<BundleComponent[]> {
  const db = getDatabase();
  return db.select({ productId: products.id, name: products.name, sku: products.sku, quantity: productBundleComponents.quantity })
    .from(productBundleComponents).innerJoin(products, eq(products.id, productBundleComponents.componentProductId))
    .where(eq(productBundleComponents.bundleProductId, bundleProductId)).orderBy(asc(products.id));
}

export async function saveBundleRecipe(bundleProductId: string, input: { productId: string; quantity: number }[], actorUsername: string): Promise<void> {
  if (input.length > MAX_COMPONENTS) throw new ProductBundleError(`A combo can contain at most ${MAX_COMPONENTS} products.`);
  const merged = new Map<string, number>();
  for (const row of input) {
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > MAX_COMPONENT_QUANTITY) throw new ProductBundleError(`Each quantity must be a whole number from 1 to ${MAX_COMPONENT_QUANTITY}.`);
    merged.set(row.productId, (merged.get(row.productId) ?? 0) + row.quantity);
  }
  const db = getDatabase();
  const [bundle] = await db.select({ id: products.id, name: products.name }).from(products).where(and(eq(products.id, bundleProductId), eq(products.active, true))).limit(1);
  if (!bundle) throw new ProductBundleError("Combo product was not found.");
  if (isPhysicalUnitProduct(bundle.name)) throw new ProductBundleError("Individual packets cannot have combo contents.");
  if (merged.has(bundle.id)) throw new ProductBundleError("A combo cannot contain itself.");
  const ids = [...merged.keys()];
  const units = ids.length ? await db.select({ id: products.id, name: products.name, active: products.active }).from(products).where(inArray(products.id, ids)) : [];
  if (units.length !== ids.length || units.some((unit) => !unit.active || !isPhysicalUnitProduct(unit.name))) {
    throw new ProductBundleError("Combo contents must be active individual packets (Pack Of 1 products).");
  }
  await db.transaction(async (tx) => {
    const previous = await tx.select({ productId: productBundleComponents.componentProductId, quantity: productBundleComponents.quantity })
      .from(productBundleComponents).where(eq(productBundleComponents.bundleProductId, bundle.id));
    await tx.delete(productBundleComponents).where(eq(productBundleComponents.bundleProductId, bundle.id));
    if (merged.size) await tx.insert(productBundleComponents).values([...merged].map(([componentProductId, quantity]) => ({ bundleProductId: bundle.id, componentProductId, quantity })));
    await tx.insert(auditEvents).values({
      actorUsername,
      action: "product.bundle_recipe_updated",
      entityType: "product",
      entityId: bundle.id,
      previousValue: { components: previous },
      newValue: { components: [...merged].map(([productId, quantity]) => ({ productId, quantity })) },
      reason: `Combo contents for ${bundle.name} updated`,
    });
  });
}
