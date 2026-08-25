const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

async function handleWebhook(rawBody, signature) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { userId, plan } = session.metadata || {};
      if (userId && plan) {
        await pool.query(
          `UPDATE users SET plan = $1, stripe_id = $2, stripe_subscription_id = $3 WHERE id = $4`,
          [plan, session.customer, session.subscription, userId]
        );
      }
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      await pool.query(
        `UPDATE users SET plan = $1, subscription_expires_at = $2 WHERE stripe_subscription_id = $3`,
        [sub.status === 'active' ? 'pro' : 'free', new Date(sub.current_period_end * 1000), sub.id]
      );
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await pool.query(
        `UPDATE users SET plan = 'free' WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
      break;
    }
  }
  return { received: true };
}

module.exports = { stripe, handleWebhook };