"use strict";

const crypto = require("node:crypto");

const ALLOWED_CATEGORIES = Object.freeze(["billing", "playback", "portal", "account", "other"]);

function createSupportService(deps) {
  const { store, catalog, mailService, now = Date.now } = deps;

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
    const notificationId = `notif_${crypto.randomBytes(8).toString("hex")}`;

    const notifications = [];
    if (userEmail) {
      notifications.push({
        id: notificationId,
        channel: "email",
        template: "ticket_received",
        recipient: userEmail,
        payloadJson: JSON.stringify({
          ticketId,
          category,
          messagePreview: trimmedMessage.slice(0, 100),
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

  async function processOutbox({ batchSize = 10 } = {}) {
    const ts = getNow();
    const pendingNotifications = store.getDueNotifications(ts, batchSize);

    let sentCount = 0;
    let failedCount = 0;

    for (const notif of pendingNotifications) {
      try {
        if (mailService && typeof mailService.sendMail === "function") {
          let payload = {};
          try {
            payload = JSON.parse(notif.payload_json || "{}");
          } catch {}

          const recipient = notif.recipient || notif.recipient_email;
          if (recipient) {
            await mailService.sendMail({
              to: recipient,
              subject: `[StreamVault Support Ticket ${payload.ticketId || notif.id}] Received`,
              text: `Thank you for contacting StreamVault support. We received your ticket regarding "${payload.category || "General"}". Our team will review it shortly.\n\nMessage preview:\n${payload.messagePreview || ""}`,
            });
          }
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
