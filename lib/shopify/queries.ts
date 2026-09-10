import "server-only";

export const INVENTORY_VARIANTS_QUERY = `#graphql
  query InventoryVariants($first: Int!, $after: String, $levelsFirst: Int!) {
    shop { name myshopifyDomain }
    productVariants(first: $first, after: $after, sortKey: ID) {
      nodes {
        id
        title
        sku
        media(first: 1) { nodes { preview { image { url } } } }
        product {
          id
          title
          status
          createdAt
          publishedAt
          media(first: 1) { nodes { preview { image { url } } } }
        }
        inventoryItem {
          id
          sku
          tracked
          createdAt
          updatedAt
          inventoryLevels(first: $levelsFirst) {
            nodes {
              id
              location { id name }
              quantities(names: ["available"]) { name quantity }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const INVENTORY_LEVELS_QUERY = `#graphql
  query InventoryLevels($inventoryItemId: ID!, $first: Int!, $after: String) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevels(first: $first, after: $after) {
        nodes {
          id
          location { id name }
          quantities(names: ["available"]) { name quantity }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const ORDERS_QUERY = `#graphql
  query SalesOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, sortKey: PROCESSED_AT, reverse: true, query: $query) {
      nodes {
        id
        name
        processedAt
        cancelledAt
        totalPriceSet { shopMoney { amount currencyCode } }
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        refunds {
          processedAt
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
        lineItems(first: 100) {
          nodes {
            title
            variantTitle
            sku
            quantity
            currentQuantity
            discountedTotalSet { shopMoney { amount currencyCode } }
            product { id title }
            variant { id }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const INVENTORY_ADJUST_QUANTITIES_MUTATION = `#graphql
  mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        id
        createdAt
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTIONS_QUERY = `#graphql
  query WebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      nodes {
        id
        topic
        uri
      }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `#graphql
  mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;
