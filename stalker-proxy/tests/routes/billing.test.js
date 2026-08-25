import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };

// Hoist mock factory BEFORE vi.mock so stripe.js can be mocked without timing issues
const { mockStripeInstances, mockHandleWebhook } = vi.hoisted(() => {
  const instances = {
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session_test' }),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal_test' }),
      },
    },
  };
  return {
    mockStripeInstances: instances,
    mockHandleWebhook: vi.fn(),
  };
});

vi.mock('../../src/stripe.js', () => ({
  stripe: mockStripeInstances,
  handleWebhook: mockHandleWebhook,
}));

import { createBillingRouter } from '../../src/routes/billing';

// Minimal mock auth object (sync middleware)
const mockAuth = {
  requireAuth: (req, _res, next) => { req.user = { stripeId: 'cus_test123' }; next(); },
};

function makeApp() {
  const app = express();
  // Raw body parser for webhook route (Stripe requires raw body for signature verification)
  app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  const router = createBillingRouter(mockPool, mockAuth, mockStripeInstances, mockHandleWebhook);
  app.use('/api/billing', router);
  return app;
}

describe('createBillingRouter', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [] });
    mockHandleWebhook.mockResolvedValue({ received: true });
    mockStripeInstances.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/session_test' });
    mockStripeInstances.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/portal_test' });
    app = makeApp();
  });

  // POST /billing/webhook — checkout.session.completed

  it('POST /billing/webhook handles checkout.session.completed', async () => {
    mockHandleWebhook.mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_test_123')
      .send(JSON.stringify({ type: 'checkout.session.completed' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockHandleWebhook).toHaveBeenCalledWith(
      expect.any(Object),
      'sig_test_123'
    );
  });

  // POST /billing/webhook — customer.subscription.updated

  it('POST /billing/webhook handles customer.subscription.updated', async () => {
    mockHandleWebhook.mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_test_456')
      .send(JSON.stringify({ type: 'customer.subscription.updated' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  // POST /billing/webhook — customer.subscription.deleted

  it('POST /billing/webhook handles customer.subscription.deleted', async () => {
    mockHandleWebhook.mockResolvedValue({ received: true });

    const res = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_test_789')
      .send(JSON.stringify({ type: 'customer.subscription.deleted' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  // POST /billing/webhook — signature verification failure

  it('POST /billing/webhook returns 400 on signature failure', async () => {
    mockHandleWebhook.mockRejectedValue(new Error('Webhook signature verification failed: test error'));

    const res = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'bad_sig')
      .send(JSON.stringify({ type: 'checkout.session.completed' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Webhook signature verification failed: test error');
  });

  // POST /billing/create-checkout

  it('POST /billing/create-checkout creates checkout session', async () => {
    const res = await request(app)
      .post('/api/billing/create-checkout')
      .send({ userId: 'user-123', plan: 'pro', priceId: 'price_abc' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/session_test');
    expect(mockStripeInstances.checkout.sessions.create).toHaveBeenCalledWith({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: 'price_abc', quantity: 1 }],
      success_url: `${process.env.APP_URL}/settings?billing=success`,
      cancel_url: `${process.env.APP_URL}/settings?billing=cancelled`,
      metadata: { userId: 'user-123', plan: 'pro' },
    });
  });

  // GET /billing/portal

  it('GET /billing/portal creates portal session', async () => {
    const res = await request(app)
      .get('/api/billing/portal');

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://billing.stripe.com/portal_test');
    expect(mockStripeInstances.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_test123',
    });
  });
});