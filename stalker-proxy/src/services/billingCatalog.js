const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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

  const POLICY_DOCUMENTS = Object.freeze({
    terms: {
      v1: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service - StreamVault (v1)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; background: #f9fafb; }
    .card { background: #ffffff; border-radius: 12px; padding: 2.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); }
    h1 { font-size: 2rem; color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.75rem; margin-top: 0; }
    h2 { font-size: 1.25rem; color: #374151; margin-top: 1.75rem; }
    p, li { font-size: 0.975rem; color: #4b5563; }
    .badge { display: inline-block; background: #e0e7ff; color: #3730a3; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; }
    .footer { margin-top: 2rem; font-size: 0.85rem; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Version 1.0 — Effective August 2026</span>
    <h1>StreamVault Terms of Service</h1>

    <h2>1. Overview & Service Description</h2>
    <p>StreamVault provides an IPTV proxy client architecture and stream management software optimized for self-hosting. By accessing the StreamVault platform, registering an account, or purchasing subscription access, you agree to be bound by these Terms.</p>

    <h2>2. Subscription Plans & Entitlements</h2>
    <p>StreamVault offers multiple access tiers:</p>
    <ul>
      <li><strong>Free Plan:</strong> Access with up to two concurrent connections and a single active login session.</li>
      <li><strong>Standard 30-Day Pass ($3.99 USD):</strong> 30 calendar days of uninterrupted access with up to five concurrent connections and three active logins. Does not auto-renew.</li>
      <li><strong>Standard Monthly Subscription ($2.99 USD/month):</strong> Recurring monthly access with up to five concurrent connections and three active logins. Automatically renews unless canceled.</li>
      <li><strong>Standard Yearly Subscription ($29.99 USD/year):</strong> Recurring annual access with up to five concurrent connections and three active logins. Automatically renews unless canceled.</li>
    </ul>

    <h2>3. Fair Use & Account Integrity</h2>
    <p>Access is restricted to authorized personal use. Users must not share credentials or bypass concurrency limits. StreamVault reserves the right to rate limit or suspend accounts violating technical limits.</p>

    <h2>4. Cancellation & Billing</h2>
    <p>Subscriptions can be canceled at any time via the Customer Billing Portal. Upon cancellation, your access remains active until the end of your current paid billing period with no further renewal charges.</p>

    <h2>5. Contact & Support</h2>
    <p>For questions or support, contact our team at <a href="mailto:support@portalheaven.stream">support@portalheaven.stream</a>.</p>
  </div>
  <div class="footer">&copy; 2026 StreamVault / Portal Heaven. All rights reserved.</div>
</body>
</html>
`,
    },
    privacy: {
      v1: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - StreamVault (v1)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; background: #f9fafb; }
    .card { background: #ffffff; border-radius: 12px; padding: 2.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); }
    h1 { font-size: 2rem; color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.75rem; margin-top: 0; }
    h2 { font-size: 1.25rem; color: #374151; margin-top: 1.75rem; }
    p, li { font-size: 0.975rem; color: #4b5563; }
    .badge { display: inline-block; background: #e0e7ff; color: #3730a3; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; }
    .footer { margin-top: 2rem; font-size: 0.85rem; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Version 1.0 — Effective August 2026</span>
    <h1>StreamVault Privacy Policy</h1>

    <h2>1. Data Privacy & Zero Raw Credential Retention</h2>
    <p>StreamVault is designed from the ground up to protect user privacy. All portal credentials, passwords, and MAC addresses are encrypted client-side in the browser using AES-GCM prior to syncing to the backend server. The server never stores or logs your raw plaintext portal credentials.</p>

    <h2>2. Payment & Billing Data</h2>
    <p>Payment transactions are processed directly by Stripe. StreamVault never receives, stores, or handles credit card numbers, CVVs, or sensitive payment details. We store only anonymized Stripe Customer IDs, Subscription IDs, and Order reference numbers in our local ledger.</p>

    <h2>3. Connection Identity Privacy</h2>
    <p>Saved portal connections are identified on the server solely through irreversible HMAC-SHA256 digests. Raw connection URLs and keys are never logged or stored in plain text.</p>

    <h2>4. Webhook and Audit Security</h2>
    <p>Stripe event webhooks are verified with HMAC signatures and logged using cryptographic SHA-256 hashes to guarantee data integrity and idempotency.</p>

    <h2>5. Inquiries</h2>
    <p>For any privacy inquiries or data requests, contact <a href="mailto:support@portalheaven.stream">support@portalheaven.stream</a>.</p>
  </div>
  <div class="footer">&copy; 2026 StreamVault / Portal Heaven. All rights reserved.</div>
</body>
</html>
`,
    },
    refund: {
      v1: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Refund Policy - StreamVault (v1)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; background: #f9fafb; }
    .card { background: #ffffff; border-radius: 12px; padding: 2.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); }
    h1 { font-size: 2rem; color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.75rem; margin-top: 0; }
    h2 { font-size: 1.25rem; color: #374151; margin-top: 1.75rem; }
    p, li { font-size: 0.975rem; color: #4b5563; }
    .badge { display: inline-block; background: #e0e7ff; color: #3730a3; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; }
    .footer { margin-top: 2rem; font-size: 0.85rem; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Version 1.0 — Effective August 2026</span>
    <h1>StreamVault Refund Policy</h1>

    <h2>1. 7-Calendar-Day Self-Service Refund Guarantee</h2>
    <p>StreamVault offers a full 7-calendar-day self-service refund guarantee on all Standard 30-Day Pass purchases and initial recurring subscription payments.</p>

    <h2>2. Eligibility Criteria</h2>
    <p>To qualify for a self-service refund:</p>
    <ul>
      <li>The refund request must be submitted within 7 calendar days (168 hours) of the original transaction timestamp.</li>
      <li>The payment must not have been previously disputed or partially refunded.</li>
      <li>The request is initiated through the authenticated Billing Settings interface on the HTTPS portal.</li>
    </ul>

    <h2>3. Refund Processing & Entitlement Adjustment</h2>
    <p>Upon submitting an eligible refund request, the payment status transitions to <code>refund_pending</code>. Once Stripe confirms the full refund via webhook, the order is marked refunded, the original payment method is credited by Stripe (typically within 5-10 business days), and your account access reverts to the Free tier with a 2-connection limit.</p>

    <h2>4. Manual Assistance</h2>
    <p>If you encounter any issues requesting an automated refund, submit a support ticket under the <strong>Billing & Refund</strong> category or email <a href="mailto:support@portalheaven.stream">support@portalheaven.stream</a> with your Order ID.</p>
  </div>
  <div class="footer">&copy; 2026 StreamVault / Portal Heaven. All rights reserved.</div>
</body>
</html>
`,
    },
  });

  function getPolicyContent(type, version = "v1") {
    const potentialPaths = [
      path.resolve(__dirname, "../../../streamvault/public/legal", `${type}-${version}.html`),
      path.resolve(__dirname, "../../public/legal", `${type}-${version}.html`),
      path.resolve(process.cwd(), "streamvault/public/legal", `${type}-${version}.html`),
      path.resolve(process.cwd(), "public/legal", `${type}-${version}.html`),
    ];

    for (const p of potentialPaths) {
      try {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, "utf8");
          return content.replace(/\r\n/g, "\n");
        }
      } catch {}
    }

    const doc = POLICY_DOCUMENTS[type]?.[version];
    if (doc) return doc.replace(/\r\n/g, "\n");

    throw billingError(
      `Missing legal policy document for type="${type}" and version="${version}". Published HTML document is required.`,
      "policy_document_missing",
      500
    );
  }

  function getPolicyContentSha256(type, version = "v1") {
    const content = getPolicyContent(type, version);
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  }

  function validatePurchaseAgreement(accepted = {}) {
    const policies = currentPolicies();
    const terms = accepted.terms || accepted.termsVersion;
    const privacy = accepted.privacy || accepted.privacyVersion;
    const refund = accepted.refund || accepted.refundVersion;

    if (!terms || terms !== policies.terms.version) {
      throw billingError(`Outdated or missing terms version: "${terms}"`, "invalid_agreement", 400);
    }
    if (!privacy || privacy !== policies.privacy.version) {
      throw billingError(`Outdated or missing privacy version: "${privacy}"`, "invalid_agreement", 400);
    }
    if (!refund || refund !== policies.refund.version) {
      throw billingError(`Outdated or missing refund version: "${refund}"`, "invalid_agreement", 400);
    }
    return true;
  }

  return {
    enabled: true,
    livemode,
    taxEnabled,
    currency: "usd",
    refundWindowDays,
    gracePeriodHours,
    appUrl,
    supportEmail,
    supportDiscordWebhookUrl: env.SUPPORT_DISCORD_WEBHOOK_URL || null,
    discordWebhookUrl: env.SUPPORT_DISCORD_WEBHOOK_URL || null,
    products: Object.values(productsMap),
    getProduct,
    listPublicProducts,
    listProducts: listPublicProducts,
    currentPolicies,
    getPolicyContent,
    getPolicyContentSha256,
    validatePurchaseAgreement,
  };
}

module.exports = {
  FIXED_PRODUCTS,
  REQUIRED_CONFIG_KEYS,
  createBillingCatalog,
  billingConfigStatus,
  billingError,
};
