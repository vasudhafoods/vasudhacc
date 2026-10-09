CREATE TABLE "product_bundle_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bundle_product_id" uuid NOT NULL,
	"component_product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_bundle_components_quantity_positive" CHECK ("product_bundle_components"."quantity" > 0),
	CONSTRAINT "product_bundle_components_not_self" CHECK ("product_bundle_components"."bundle_product_id" <> "product_bundle_components"."component_product_id")
);
--> statement-breakpoint
ALTER TABLE "product_bundle_components" ADD CONSTRAINT "product_bundle_components_bundle_product_id_products_id_fk" FOREIGN KEY ("bundle_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_bundle_components" ADD CONSTRAINT "product_bundle_components_component_product_id_products_id_fk" FOREIGN KEY ("component_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_bundle_components_unique" ON "product_bundle_components" USING btree ("bundle_product_id","component_product_id");