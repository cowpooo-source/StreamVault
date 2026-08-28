"use strict";

const crypto = require("node:crypto");

const ALLOWED_CATEGORIES = Object.freeze([
  "billing_refund",
  "payment_failed",
  "account",
  "technical",
  "other",
  // Legacy / UI aliases
  "billing",
  "playback",
  "portal",
]);

function createSupportService(deps) {
  const { store, catalog, mailService, fetchFn = globalThis.fetch, now = Date.now } = deps;

  function getNow() {
    return typeof now === "function" ? now() : Date.now();
  }

  async function createTicket({ userId, userEmail = null, category, message, orderId = null, stripeCustomerId = null }) {
    if (!category || !ALLOWED_CATEGORIES.includes(category)) {
      const err = new Error(`Invalid ticket category. Must be one of: ${ALLOWED_CATEGORIES.join(", ")}`);
      err.code = "invalid_category";
      err.status = 400;
      throw err;
    }

    const trimmedMessage = String(message || "").trim();
    if (trimmedMessage.length < 10 || trimmedMessage.length > 4000) {
      const err = new Error("Message length must be between 10 and 4000 characters");
      err.code = "invalid_message_length";
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
          category,
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
        category,
        orderId,
        messagePreview: trimmedMessage.slice(0, 300),
        createdAt: ts,
      }),
      status: "queued",
      nextAttemptAt: ts,
    });

    // 3. Discord webhook alert (if configured)
    const discordWebhookUrl = catalog?.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL;
    if (discordWebhookUrl) {
      notifications.push({
        id: `notif_${crypto.randomBytes(8).toString("hex")}`,
        channel: "discord",
        template: "ticket_discord_alert",
        recipient: discordWebhookUrl,
        payloadJson: JSON.stringify({
          ticketId,
          userId,
          category,
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
        category,
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

  async function processOutbox({ batchSize = 20 } = {}) {
    const ts = getNow();
    const pendingNotifications = store.getDueNotifications(ts, batchSize);

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
          await fetchFn(recipient, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              embeds: [
                {
                  title: `[Support Ticket ${payload.ticketId || notif.id}]`,
                  description: payload.messagePreview || "New support ticket received",
                  color: 0x3b82f6,
                  fields: [
                    { name: "Category", value: payload.category || "General", inline: true },
                    { name: "User ID", value: String(payload.userId || notif.user_id || "N/A"), inline: true },
                  ],
                  timestamp: new Date(payload.createdAt || ts).toISOString(),
                },
              ],
            }),
          });
        } else if (notif.channel === "email" && recipient && mailService && typeof mailService.sendMail === "function") {
          const isUserAck = notif.template === "ticket_received";
          const subject = isUserAck
            ? `[StreamVault Support Ticket ${payload.ticketId || notif.id}] Received`
            : `[SUPPORT ALERT] Ticket #${payload.ticketId || notif.id} (${payload.category || "General"}) from User #${payload.userId || "N/A"}`;

          const text = isUserAck
            ? `Thank you for contacting StreamVault support. We received your ticket regarding "${payload.category || "General"}". Our team will review it shortly.\n\nMessage preview:\n${payload.messagePreview || ""}`
            : `New support ticket received:\nTicket ID: ${payload.ticketId || notif.id}\nUser ID: ${payload.userId || "N/A"}\nUser Email: ${payload.userEmail || "none"}\nCategory: ${payload.category || "General"}\nOrder ID: ${payload.orderId || "N/A"}\n\nMessage:\n${payload.messagePreview || ""}`;

          await mailService.sendMail({
            to: recipient,
            subject,
            text,
          });
        }

        store.markNotificationSent(notif.id);
        sentCount++;
      } catch (err) {
        failedCount++;
        const attemptCount = (notif.attempt_count || 0) + 1;
        // Exponential backoff: attempt * 5 minutes
        const backoffMs = attemptCount * 5 * 60 * 1000;
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
  };
}

module.exports = {
  createSupportService,
  ALLOWED_CATEGORIES,
};
