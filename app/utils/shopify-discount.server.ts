import { logInfo, logWarn, logError } from "./logger.server";

export interface ShopifyDiscountOption {
  id: string;
  title: string;
  code: string;
  status: string;
  summary: string;
}

/**
 * Fetches active discount codes directly from Shopify Admin via GraphQL.
 */
export async function fetchShopifyDiscounts(admin: any): Promise<ShopifyDiscountOption[]> {
  try {
    const response = await admin.graphql(
      `#graphql
      query getShopifyDiscounts {
        codeDiscountNodes(first: 50, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                status
                codes(first: 5) {
                  nodes {
                    code
                  }
                }
                customerGets {
                  value {
                    ... on DiscountPercentage {
                      percentage
                    }
                    ... on DiscountAmount {
                      amount {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
              ... on DiscountCodeBxgy {
                title
                status
                codes(first: 5) {
                  nodes {
                    code
                  }
                }
              }
              ... on DiscountCodeFreeShipping {
                title
                status
                codes(first: 5) {
                  nodes {
                    code
                  }
                }
              }
            }
          }
        }
      }`
    );

    const json = await response.json();
    const nodes = json.data?.codeDiscountNodes?.nodes || [];
    const discounts: ShopifyDiscountOption[] = [];

    for (const node of nodes) {
      const cd = node.codeDiscount;
      if (!cd || cd.status !== "ACTIVE") continue;

      const codeList = cd.codes?.nodes || [];
      for (const codeObj of codeList) {
        if (!codeObj.code) continue;

        let summary = "Shopify Discount";
        if (cd.customerGets?.value?.percentage) {
          summary = `${Math.round(cd.customerGets.value.percentage * 100)}% Off`;
        } else if (cd.customerGets?.value?.amount) {
          const amt = cd.customerGets.value.amount;
          summary = `${amt.currencyCode || ""} ${amt.amount} Off`;
        }

        discounts.push({
          id: node.id,
          title: cd.title || codeObj.code,
          code: codeObj.code,
          status: cd.status,
          summary,
        });
      }
    }

    return discounts;
  } catch (err: any) {
    await logWarn(`Failed to query Shopify discounts: ${err.message}`, { source: "shopify-discount" });
    return [];
  }
}

/**
 * Creates a permanent store-wide basic discount in Shopify Admin.
 */
export async function createShopifyBasicDiscount(
  admin: any,
  options: {
    code: string;
    percentage?: number;
    title?: string;
  }
) {
  const { code, percentage = 10, title } = options;
  const cleanCode = code.trim().toUpperCase();

  try {
    const response = await admin.graphql(
      `#graphql
      mutation createBasicDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
          codeDiscountNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                status
                codes(first: 1) {
                  nodes {
                    code
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          basicCodeDiscount: {
            title: title || `StorePing Discount (${cleanCode})`,
            code: cleanCode,
            startsAt: new Date().toISOString(),
            customerGets: {
              value: {
                percentage: percentage / 100,
              },
              items: {
                all: true,
              },
            },
            customerSelection: {
              all: true,
            },
            appliesOncePerCustomer: false,
          },
        },
      }
    );

    const json = await response.json();
    const userErrors = json.data?.discountCodeBasicCreate?.userErrors || [];

    if (userErrors.length > 0) {
      // If code already exists, treat as success so merchant can use it
      const alreadyExists = userErrors.some((e: any) =>
        e.message?.toLowerCase().includes("taken") || e.message?.toLowerCase().includes("already")
      );
      if (alreadyExists) {
        return { success: true, code: cleanCode, existing: true };
      }
      return { success: false, error: userErrors.map((e: any) => e.message).join(", ") };
    }

    return {
      success: true,
      code: cleanCode,
      id: json.data?.discountCodeBasicCreate?.codeDiscountNode?.id,
    };
  } catch (err: any) {
    await logError(`Failed to create basic Shopify discount: ${err.message}`, { source: "shopify-discount" });
    return { success: false, error: err.message };
  }
}

/**
 * Creates a unique, single-use, self-destroying dynamic discount coupon in Shopify Admin.
 * Sets `usageLimit: 1` and `endsAt` timestamp so it cannot be leaked or reused.
 */
export async function createDynamicOneTimeDiscount(
  admin: any,
  options: {
    prefix?: string;
    percent?: number;
    expiryHours?: number;
    checkoutToken?: string;
  }
) {
  const prefix = (options.prefix || "CART").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "CART";
  const percent = options.percent || 10;
  const expiryHours = options.expiryHours || 24;

  // Generate unique 4-character alphanumeric identifier
  const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  const uniqueCode = `${prefix}${percent}-${randomSuffix}`;

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + expiryHours * 60 * 60 * 1000);

  try {
    const response = await admin.graphql(
      `#graphql
      mutation createOneTimeDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
          codeDiscountNode {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                status
                endsAt
                codes(first: 1) {
                  nodes {
                    code
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          basicCodeDiscount: {
            title: `StorePing 1-Time Recovery Coupon (${uniqueCode})`,
            code: uniqueCode,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            usageLimit: 1, // 👈 KEY: Exactly 1 usage across entire store!
            appliesOncePerCustomer: true,
            customerGets: {
              value: {
                percentage: percent / 100,
              },
              items: {
                all: true,
              },
            },
            customerSelection: {
              all: true,
            },
          },
        },
      }
    );

    const json = await response.json();
    const userErrors = json.data?.discountCodeBasicCreate?.userErrors || [];

    if (userErrors.length > 0) {
      await logWarn(`1-time discount userErrors for ${uniqueCode}: ${userErrors.map((e: any) => e.message).join(", ")}`, {
        source: "shopify-discount",
      });
      return { success: false, code: uniqueCode, error: userErrors.map((e: any) => e.message).join(", ") };
    }

    await logInfo(`Created dynamic 1-time discount ${uniqueCode} (${percent}%, valid for ${expiryHours}h, usageLimit: 1)`, {
      source: "shopify-discount",
    });

    return {
      success: true,
      code: uniqueCode,
      endsAt,
      id: json.data?.discountCodeBasicCreate?.codeDiscountNode?.id,
    };
  } catch (err: any) {
    await logError(`Error creating dynamic 1-time discount: ${err.message}`, { source: "shopify-discount" });
    return { success: false, code: uniqueCode, error: err.message };
  }
}
