import "server-only";
import { getShopifyConfig } from "@/lib/validation/env";
import { getShopifyAccessToken, invalidateShopifyAccessToken } from "./access-token";
import { ShopifyAuthenticationError, ShopifyGraphQLError, ShopifyNetworkError, ShopifyRateLimitError, ShopifyUserError } from "./errors";

interface GraphQLErrorShape { message: string; extensions?: { code?: string }; }
interface UserErrorShape { message: string; code?: string; }
interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorShape[];
  extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number | null; throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } } };
}

const MAX_ATTEMPTS = 3;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function collectUserErrors(data: unknown): UserErrorShape[] {
  if (!data || typeof data !== "object") return [];
  const errors: UserErrorShape[] = [];
  for (const payload of Object.values(data)) {
    if (!payload || typeof payload !== "object" || !("userErrors" in payload)) continue;
    const userErrors = (payload as { userErrors?: unknown }).userErrors;
    if (!Array.isArray(userErrors)) continue;
    for (const userError of userErrors) {
      if (!userError || typeof userError !== "object" || !("message" in userError) || typeof userError.message !== "string") continue;
      errors.push({
        message: userError.message,
        code: "code" in userError && typeof userError.code === "string" ? userError.code : undefined,
      });
    }
  }
  return errors;
}

function retryDelay(attempt: number, response?: GraphQLResponse<unknown>): number {
  const throttle = response?.extensions?.cost?.throttleStatus;
  const requested = response?.extensions?.cost?.requestedQueryCost ?? 0;
  if (throttle && throttle.restoreRate > 0) return Math.max(500, Math.ceil(((requested - throttle.currentlyAvailable) / throttle.restoreRate) * 1000));
  return 500 * 2 ** attempt;
}

export async function shopifyGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const config = getShopifyConfig();
  const endpoint = `https://${config.storeDomain}/admin/api/${config.apiVersion}/graphql.json`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const accessToken = await getShopifyAccessToken();
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt < MAX_ATTEMPTS - 1) { await sleep(retryDelay(attempt)); continue; }
      throw new ShopifyNetworkError();
    }
    if (response.status === 401 && attempt < MAX_ATTEMPTS - 1) { invalidateShopifyAccessToken(); continue; }
    if (response.status === 401 || response.status === 403) throw new ShopifyAuthenticationError();
    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_ATTEMPTS - 1) { const retryAfter = Number(response.headers.get("retry-after")); await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelay(attempt)); continue; }
      if (response.status === 429) throw new ShopifyRateLimitError();
      throw new ShopifyNetworkError();
    }
    if (!response.ok) throw new ShopifyGraphQLError(`Shopify returned HTTP ${response.status}.`);
    let body: GraphQLResponse<T>;
    try { body = await response.json() as GraphQLResponse<T>; } catch { throw new ShopifyGraphQLError("Shopify returned an invalid JSON response."); }
    const throttled = body.errors?.some((error) => error.extensions?.code === "THROTTLED") ?? false;
    if (throttled && attempt < MAX_ATTEMPTS - 1) { await sleep(retryDelay(attempt, body as GraphQLResponse<unknown>)); continue; }
    if (throttled) throw new ShopifyRateLimitError();
    if (body.errors?.length) throw new ShopifyGraphQLError(body.errors.map((error) => error.message).join("; "));
    if (!body.data) throw new ShopifyGraphQLError("Shopify response did not include data.");
    const userErrors = collectUserErrors(body.data);
    if (userErrors.length) throw new ShopifyUserError(userErrors.map((error) => error.message).join("; "), userErrors.flatMap((error) => error.code ? [error.code] : []));
    return body.data;
  }
  throw new ShopifyRateLimitError();
}
