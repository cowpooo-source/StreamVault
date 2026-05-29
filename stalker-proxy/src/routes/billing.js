import { Router } from 'express';

export function createBillingRouter(pool, auth, stripeInstance, handleWebhook) {
  const router = Router();
  const stripe = stripeInstance;

  // POST /billing/webhook — Stripe webhook receiver
  router.post('/webhook', async (req, res) => {
    const signature = req.headers['stripe-signature'];
    try {
      const result = await handleWebhook(req.body, signature);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /billing/create-checkout — create Stripe checkout session
  router.post('/create-checkout', async (req, res) => {
    const { userId, plan, priceId } = req.body;
    const { url } = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/settings?billing=success`,
      cancel_url: `${process.env.APP_URL}/settings?billing=cancelled`,
      metadata: { userId, plan }
    });
    res.json({ url });
  });

  // GET /billing/portal — create Stripe customer portal session
  router.get('/portal', auth.requireAuth, async (req, res) => {
    const { stripeId } = req.user;
    const { url } = await stripe.billingPortal.sessions.create({ customer: stripeId });
    await res.json({ url });
  });

  return router;
}