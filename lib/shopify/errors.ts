import "server-only";

export class ShopifyError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); this.name = "ShopifyError"; }
}
export class ShopifyAuthenticationError extends ShopifyError {
  constructor(detail?: string) { super(detail ? `Shopify authentication failed: ${detail}` : "Shopify rejected the configured credentials.", "SHOPIFY_AUTHENTICATION_ERROR", 502); this.name = "ShopifyAuthenticationError"; }
}
export class ShopifyRateLimitError extends ShopifyError {
  constructor() { super("Shopify rate limit exceeded after retries.", "SHOPIFY_RATE_LIMIT_ERROR", 503); this.name = "ShopifyRateLimitError"; }
}
export class ShopifyGraphQLError extends ShopifyError {
  constructor(message: string) { super(message, "SHOPIFY_GRAPHQL_ERROR", 502); this.name = "ShopifyGraphQLError"; }
}
export class ShopifyUserError extends ShopifyError {
  constructor(message: string, readonly errorCodes: string[]) {
    super(message, "SHOPIFY_USER_ERROR", 502);
    this.name = "ShopifyUserError";
  }
}
export class ShopifyNetworkError extends ShopifyError {
  constructor() { super("Shopify could not be reached.", "SHOPIFY_NETWORK_ERROR", 502); this.name = "ShopifyNetworkError"; }
}
