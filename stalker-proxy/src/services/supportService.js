"use strict";

const crypto = require("node:crypto");

const ALLOWED_CATEGORIES = Object.freeze([
  "billing_refund",
  "payment_failed",
  "account",
  "technical",
  "other",
]);

const CATEGORY_MAP = Object.freeze({
  "billing_refund": "billing_refund",
  "billing/refund": "billing_refund",
  "billing & refund": "billing_refund",
  "payment_failed": "payment_failed",
  "payment failed": "payment_failed",
  "payment issue": "payment_failed",
  "account": "account",
  "account & security": "account",
  "technical": "technical",
  "technical & playback": "technical",
  "other": "other",
  "other inquiry": "other",
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function formatBillingEmail(template, payload) {
  const details = [
    ["Product", payload.productCode || "Standard"],
    ["Order", payload.orderId || null],
    ["Subscription", payload.subscriptionId || null],
    ["Access ends", payload.accessEndsAt ? new Date(payload.accessEndsAt).toLocaleString() : null],
  ].filter(([, value]) => value);
  const copy = {
    billing_subscription_created: {
      subject: "Your Portal Heaven subscription is active",
      heading: "Subscription created",
      message: "Your Standard subscription is active and your account access has been updated.",
    },
    billing_subscription_canceled: {
      subject: "Your Portal Heaven subscription was canceled",
      heading: "Subscription canceled",
      message: payload.cancellationType === "period_end"
        ? "Your subscription will not renew. Access remains available until the end of the current paid period."
        : "Your subscription has been canceled and access has been updated.",
    },
    billing_refund_completed: {
      subject: "Your Portal Heaven refund was completed",
      heading: "Refund completed",
      message: "Stripe confirmed your refund. Your account has returned to the Free tier.",
    },
  }[template] || {
    subject: "Portal Heaven billing update",
    heading: "Billing update",
    message: "There was an update to your Portal Heaven billing account.",
  };
  const text = `${copy.message}\n\n${details.map(([label, value]) => `${label}: ${value}`).join("\n")}`;
  const htmlDetails = details
    .map(([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`)
    .join("");
  const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <h2>${escapeHtml(copy.heading)}</h2>
    <p>${escapeHtml(copy.message)}</p>
    ${htmlDetails ? `<ul>${htmlDetails}</ul>` : ""}
    <p>Portal Heaven Support</p>
  </div>`;
  return { subject: copy.subject, text, html };
}

function normalizeCategory(cat) {
  if (!cat) return null;
  const key = String(cat).trim().toLowerCase();
  return CATEGORY_MAP[key] || null;
}

function luhnCheck(numStr) {
  let sum = 0;
  let alternate = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let n = parseInt(numStr.charAt(i), 10);
    if (isNaN(n)) return false;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function containsSensitiveSupportData(text) {
  if (!text || typeof text !== "string") return false;

  // 1. Credit card numbers (13-19 digits, with spaces/hyphens)
  const potentialCards = text.match(/(?:\b\d(?:[ -]?\d){11,18}\b)/g);
  if (potentialCards) {
    for (const raw of potentialCards) {
      const digits = raw.replace(/\D/g, "");
      if (digits.length >= 13 && digits.length <= 19) {
        if (
          /^(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11}|(?:[0-9]{4}[ -]?){3,4}[0-9]{1,4})$/.test(
            raw
          ) ||
          luhnCheck(digits)
        ) {
          return true;
        }
      }
    }
  }

  // 2. URLs with embedded credentials (e.g. http://user:pass@host)
  const credUrlRegex = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/;
  if (credUrlRegex.test(text)) {
    return true;
  }

  // 3. Password and credential phrases (e.g. password: xyz, pass=xyz, api_key: xyz)
  const credPhraseRegex = /\b(?:password|passwd|pass|secret|api_?key|credentials?|token|auth_token)\s*[:=]\s*[^\s]+/i;
  if (credPhraseRegex.test(text)) {
    return true;
  }

  // 4. Content-token / JWT-like strings (e.g. eyJ..., ctok_..., sess_...)
  const jwtRegex = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
  if (jwtRegex.test(text)) {
    return true;
  }

  const tokenSigRegex = /\b(?:ctok|sess|bearer|jwt|token)_[a-zA-Z0-9_-]{16,}\b/i;
  if (tokenSigRegex.test(text)) {
    return true;
  }

  return false;
}

function createSupportService(deps) {
  const { store, catalog, mailService, fetchFn = globalThis.fetch, now = Date.now } = deps;

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  async function createTicket({ userId, userEmail = null, category, message, orderId = null, stripeCustomerId = null }) {
    const normalizedCategory = normalizeCategory(category);
    if (!normalizedCategory) {
      const err = new Error(`Invalid ticket category. Must be one of: ${ALLOWED_CATEGORIES.join(", ")}`);
      err.code = "invalid_category";
      err.status = 400;
      throw err;
    }

    const trimmedMessage = String(message || "").trim();
    if (trimmedMessage.length < 10) {
      const err = new Error("Message length must be at least 10 characters");
      err.code = "invalid_message_length";
      err.status = 400;
      throw err;
    }
    if (trimmedMessage.length > 2000) {
      const err = new Error("Message length exceeds maximum 2000 characters");
      err.code = "invalid_message_length";
      err.status = 400;
      throw err;
    }

    // Sensitive content rejection (card numbers, passwords, URLs with credentials, tokens)
    if (containsSensitiveSupportData(trimmedMessage)) {
      const err = new Error(
        "Message contains sensitive information such as card numbers, credentials, URLs with passwords, or access tokens."
      );
      err.code = "support_sensitive_content";
      err.status = 400;
      throw err;
    }

    const ts = getNow();
    const oneDayAgo = ts - 24 * 3600 * 1000;

    // Rate limit: 5 tickets per user per 24 hours
    const userTickets = store.listTicketsForUser(userId);
    const recentTickets = userTickets.filter((t) => t.created_at >= oneDayAgo);
    if (recentTickets.length >= 5) {
      const err = new Error("Rate limit exceeded: maximum 5 tickets per 24 hours");
      err.code = "ticket_rate_limited";
      err.status = 429;
      throw err;
    }

    const ticketId = `tkt_${crypto.randomBytes(8).toString("hex")}`;
    const notifications = [];

    // 1. User email confirmation
    if (userEmail) {
      notifications.push({
        id: `notif_${crypto.randomBytes(8).toString("hex")}`,
        channel: "email",
        template: "ticket_received",
        recipient: userEmail,
        payloadJson: JSON.stringify({
          ticketId,
          userId,
          category: normalizedCategory,
          messagePreview: trimmedMessage.slice(0, 150),
          createdAt: ts,
        }),
        status: "queued",
        nextAttemptAt: ts,
      });
    }

    // 2. Support team email alert
    const supportEmail = catalog?.supportEmail || process.env.SUPPORT_EMAIL || "support@portalheaven.stream";
    notifications.push({
      id: `notif_${crypto.randomBytes(8).toString("hex")}`,
      channel: "email",
      template: "support_team_ticket_alert",
      recipient: supportEmail,
      payloadJson: JSON.stringify({
        ticketId,
        userId,
        userEmail: userEmail || "none",
        category: normalizedCategory,
        orderId,
        messagePreview: trimmedMessage.slice(0, 300),
        createdAt: ts,
      }),
      status: "queued",
      nextAttemptAt: ts,
    });

    // 3. Isolated Support Discord webhook alert
    const supportDiscordWebhookUrl = catalog?.supportDiscordWebhookUrl || process.env.SUPPORT_DISCORD_WEBHOOK_URL || null;
    if (supportDiscordWebhookUrl) {
      notifications.push({
        id: `notif_${crypto.randomBytes(8).toString("hex")}`,
        channel: "discord",
        template: "ticket_discord_alert",
        recipient: supportDiscordWebhookUrl,
        payloadJson: JSON.stringify({
          ticketId,
          userId,
          category: normalizedCategory,
          messagePreview: trimmedMessage.slice(0, 200),
          createdAt: ts,
        }),
        status: "queued",
        nextAttemptAt: ts,
      });
    }

    const result = store.createTicketWithNotifications({
      ticket: {
        id: ticketId,
        userId,
        category: normalizedCategory,
        message: trimmedMessage,
        status: "open",
        stripeCustomerId,
        stripeOrderId: orderId,
        createdAt: ts,
      },
      notifications,
    });

    return result.ticket;
  }

  function listTickets(userId) {
    return store.listTicketsForUser(userId);
  }

  function getTicket(userId, ticketId) {
    const ticket = store.getTicket(ticketId);
    if (!ticket || ticket.user_id !== userId) {
      return null;
    }
    return ticket;
  }

  async function processOutbox({ batchSize = 20, lockDurationMs = 300000 } = {}) {
    const ts = getNow();
    // Concurrency-safe atomic claim
    const pendingNotifications = store.claimDueNotifications
      ? store.claimDueNotifications(ts, batchSize, lockDurationMs)
      : store.getDueNotifications(ts, batchSize);

    let sentCount = 0;
    let failedCount = 0;

    for (const notif of pendingNotifications) {
      try {
        let payload = {};
        try {
          payload = JSON.parse(notif.payload_json || "{}");
        } catch {}

        const recipient = notif.recipient || notif.recipient_email;

        if (notif.channel === "discord" && recipient && fetchFn) {
          const billingTitle = {
            billing_subscription_created: "Subscription created",
            billing_subscription_canceled: "Subscription canceled",
            billing_refund_completed: "Refund completed",
          }[notif.template];
          const isBillingNotification = Boolean(billingTitle);
          const res = await fetchFn(recipient, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              embeds: [
                {
                  title: isBillingNotification
                    ? `[Billing] ${billingTitle}`
                    : `[Support Ticket ${payload.ticketId || notif.id}]`,
                  description: isBillingNotification
                    ? (payload.cancellationType === "period_end"
                      ? "A subscription was canceled at period end."
                      : billingTitle)
                    : (payload.messagePreview || "New support ticket received"),
                  color: isBillingNotification ? 0xf59e0b : 0x3b82f6,
                  fields: isBillingNotification
                    ? [
                      { name: "User ID", value: String(payload.userId || notif.user_id || "N/A"), inline: true },
                      { name: "Product", value: String(payload.productCode || "Standard"), inline: true },
                      ...(payload.orderId ? [{ name: "Order", value: String(payload.orderId), inline: true }] : []),
                      ...(payload.subscriptionId ? [{ name: "Subscription", value: String(payload.subscriptionId), inline: true }] : []),
                    ]
                    : [
                      { name: "Category", value: payload.category || "General", inline: true },
                      { name: "User ID", value: String(payload.userId || notif.user_id || "N/A"), inline: true },
                    ],
                  timestamp: new Date(payload.createdAt || ts).toISOString(),
                },
              ],
            }),
          });
          if (!res || !res.ok) {
            const status = res ? res.status : "unknown";
            throw new Error(`Discord webhook responded with status ${status}`);
          }
        } else if (notif.channel === "email" && recipient && mailService) {
          const sendMail = mailService.sendMail || mailService.sendEmail;
          if (typeof sendMail !== "function") {
            throw new Error("email_service_unavailable");
          }
          const isUserAck = notif.template === "ticket_received";
          const billingEmail = notif.template.startsWith("billing_")
            ? formatBillingEmail(notif.template, payload)
            : null;
          const subject = billingEmail?.subject || (isUserAck
            ? `[StreamVault Support Ticket ${payload.ticketId || notif.id}] Received`
            : `[SUPPORT ALERT] Ticket #${payload.ticketId || notif.id} (${payload.category || "General"}) from User #${payload.userId || "N/A"}`);

          const text = billingEmail?.text || (isUserAck
            ? `Thank you for contacting StreamVault support. We received your ticket regarding "${payload.category || "General"}". Our team will review it shortly.\n\nMessage preview:\n${payload.messagePreview || ""}`
            : `New support ticket received:\nTicket ID: ${payload.ticketId || notif.id}\nUser ID: ${payload.userId || "N/A"}\nUser Email: ${payload.userEmail || "none"}\nCategory: ${payload.category || "General"}\nOrder ID: ${payload.orderId || "N/A"}\n\nMessage:\n${payload.messagePreview || ""}`);
          const html = billingEmail?.html || `<div style="font-family:sans-serif;white-space:pre-line">${escapeHtml(text)}</div>`;

          const result = await sendMail({
            to: recipient,
            subject,
            text,
            html,
          });
          if (result === false) throw new Error("email_send_failed");
        }

        store.markNotificationSent(notif.id);
        sentCount++;
      } catch (err) {
        failedCount++;
        const attemptCount = (notif.attempt_count || 0) + 1;
        // Bounded exponential backoff: 1, 5, 30, 120 minutes (max 5 attempts)
        const backoffMinutes = [1, 5, 30, 120, 360][Math.min(attemptCount - 1, 4)];
        const backoffMs = backoffMinutes * 60 * 1000;
        store.markNotificationFailed(notif.id, {
          nextAttemptAt: ts + backoffMs,
          lastErrorCode: err.message || "send_failed",
        });
      }
    }

    return { sentCount, failedCount };
  }

  return {
    createTicket,
    listTickets,
    getTicket,
    processOutbox,
    containsSensitiveSupportData,
    normalizeCategory,
  };
}

module.exports = {
  createSupportService,
  ALLOWED_CATEGORIES,
};
