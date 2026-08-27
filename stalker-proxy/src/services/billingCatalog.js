"use strict";

const FIXED_PRODUCTS = Object.freeze({
  standard_pass_30d: {
    code: "standard_pass_30d",
    name: "Standard 30-Day Pass",
    mode: "payment",
    currency: "usd",
    amount: 399,
    interval: null,
    envPriceKey: "STRIPE_PRICE_STANDARD_PASS_30D",
    display: {
      title: "Standard 30-Day Pass",
      priceFormatted: "$3.99",
      billingBehavior: "One-time payment, 30 days of access",
      cadence: "one-time",
    },
  },
  standard_monthly: {
    code: "standard_monthly",
    name: "Standard Monthly",
    mode: "subscription",
    currency: "usd",
    amount: 299,
    interval: "month",
    envPriceKey: "STRIPE_PRICE_STANDARD_MONTHLY",
    display: {
      title: "Standard Monthly",
      priceFormatted: "$2.99",
      billingBehavior: "Renews monthly until canceled",
      cadence: "month",
    },
  },
  standard_yearly: {
    code: "standard_yearly",
    name: "Standard Yearly",
    mode: "subscription",
    currency: "usd",
    amount: 2999,
    interval: "year",
    envPriceKey: "STRIPE_PRICE_STANDARD_YEARLY",
    display: {
      title: "Standard Yearly",
      priceFormatted: "$29.99",
      billingBehavior: "Renews annually until canceled",
      cadence: "year",
      monthlyEquivalentFormatted: "$2.50",
      badge: "Best Value",
    },
  },
});

const REQUIRED_CONFIG_KEYS = Object.freeze([
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STANDARD_PASS_30D",
  "STRIPE_PRICE_STANDARD_MONTHLY",
  "STRIPE_PRICE_STANDARD_YEARLY",
  "STRIPE_LIVE_MODE",
  "POLICY_TERMS_VERSION",
  "POLICY_TERMS_URL",
  "POLICY_PRIVACY_VERSION",
  "POLICY_PRIVACY_URL",
  "POLICY_REFUND_VERSION",
  "POLICY_REFUND_URL",
]);

function billingError(message, code = "billing_error", status = 400) {
  const err = new Error(`${message} [${code}]`);
  err.code = code;
  err.status = status;
  return err;
}

function resolvePolicies(env = {}, strict = false) {
  if (strict) {
    const missingPolicies = [];
    if (!env.POLICY_TERMS_VERSION) missingPolicies.push("POLICY_TERMS_VERSION");
    if (!env.POLICY_TERMS_URL) missingPolicies.push("POLICY_TERMS_URL");
    if (!env.POLICY_PRIVACY_VERSION) missingPolicies.push("POLICY_PRIVACY_VERSION");
    if (!env.POLICY_PRIVACY_URL) missingPolicies.push("POLICY_PRIVACY_URL");
    if (!env.POLICY_REFUND_VERSION) missingPolicies.push("POLICY_REFUND_VERSION");
    if (!env.POLICY_REFUND_URL) missingPolicies.push("POLICY_REFUND_URL");
    if (missingPolicies.length > 0) {
      throw new Error(`Policy configuration incomplete. Missing variables: ${missingPolicies.join(", ")}`);
    }
  }
  return {
    terms: {
      version: env.POLICY_TERMS_VERSION || "v1",
      publicUrl: env.POLICY_TERMS_URL || "https://media.portalheaven.stream/legal/terms-v1.html",
    },
    privacy: {
      version: env.POLICY_PRIVACY_VERSION || "v1",
      publicUrl: env.POLICY_PRIVACY_URL || "https://media.portalheaven.stream/legal/privacy-v1.html",
    },
    refund: {
      version: env.POLICY_REFUND_VERSION || "v1",
      publicUrl: env.POLICY_REFUND_URL || "https://media.portalheaven.stream/legal/refund-v1.html",
    },
  };
}

function billingConfigStatus(env = process.env) {
  const enabled = env.BILLING_ENABLED === "true" || env.BILLING_ENABLED === true;
  const missing = [];
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!env[key] || String(env[key]).trim() === "") {
      missing.push(key);
    }
  }
  const configured = enabled && missing.length === 0;
  const livemode = env.STRIPE_LIVE_MODE === "true" || env.STRIPE_LIVE_MODE === true;
  const taxEnabled = env.STRIPE_TAX_ENABLED !== "false";

  return {
    enabled,
    configured,
    livemode,
    taxEnabled,
    missing: enabled ? missing : [],
  };
}

function createBillingCatalog(env = process.env) {
  const enabled = env.BILLING_ENABLED === "true" || env.BILLING_ENABLED === true;

  if (!enabled) {
    return {
      enabled: false,
      livemode: false,
      taxEnabled: false,
      refundWindowDays: Number(env.BILLING_REFUND_WINDOW_DAYS) || 7,
      gracePeriodHours: Number(env.BILLING_GRACE_PERIOD_HOURS) || 72,
      appUrl: env.APP_URL || "https://media.portalheaven.stream/app",
      supportEmail: env.SUPPORT_EMAIL || "support@portalheaven.stream",
      products: [],
      getProduct(code) {
        throw billingError("Billing is currently disabled", "billing_disabled", 400);
      },
      listPublicProducts() {
        return [];
      },
      currentPolicies() {
        return resolvePolicies(env);
      },
    };
  }

  // Validate required configuration when enabled
  const missing = [];
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!env[key] || String(env[key]).trim() === "") {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Billing configuration incomplete. Missing required variables: ${missing.join(", ")}`);
  }

  const livemode = env.STRIPE_LIVE_MODE === "true" || env.STRIPE_LIVE_MODE === true;
  const taxEnabled = env.STRIPE_TAX_ENABLED !== "false";
  const refundWindowDays = Number(env.BILLING_REFUND_WINDOW_DAYS) || 7;
  const gracePeriodHours = Number(env.BILLING_GRACE_PERIOD_HOURS) || 72;
  const appUrl = env.APP_URL || "https://media.portalheaven.stream/app";
  const supportEmail = env.SUPPORT_EMAIL || "support@portalheaven.stream";

  const productsMap = {};
  for (const [code, def] of Object.entries(FIXED_PRODUCTS)) {
    productsMap[code] = {
      code: def.code,
      name: def.name,
      mode: def.mode,
      currency: def.currency,
      amount: def.amount,
      interval: def.interval,
      priceId: env[def.envPriceKey],
      display: { ...def.display },
    };
  }

  function getProduct(code) {
    const product = productsMap[code];
    if (!product) {
      throw billingError(`Invalid billing product: "${code}"`, "billing_product_invalid", 400);
    }
    return product;
  }

  function listPublicProducts() {
    return Object.values(productsMap).map((p) => ({
      code: p.code,
      name: p.name,
      mode: p.mode,
      currency: p.currency,
      amount: p.amount,
      interval: p.interval,
      display: p.display,
    }));
  }

  function currentPolicies() {
    return resolvePolicies(env, true);
  }

  return {
    enabled: true,
    livemode,
    taxEnabled,
    refundWindowDays,
    gracePeriodHours,
    appUrl,
    supportEmail,
    products: Object.values(productsMap),
    getProduct,
    listPublicProducts,
    currentPolicies,
  };
}

module.exports = {
  FIXED_PRODUCTS,
  REQUIRED_CONFIG_KEYS,
  createBillingCatalog,
  billingConfigStatus,
  billingError,
};
