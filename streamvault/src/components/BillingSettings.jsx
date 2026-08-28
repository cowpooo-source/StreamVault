import React, { useState, useEffect } from "react";

export default function BillingSettings({ billingApi, accessState = {}, onRefresh }) {
  const [config, setConfig] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionSuccess, setActionSuccess] = useState(null);
  const [agreedPolicies, setAgreedPolicies] = useState(false);
  const [processingProduct, setProcessingProduct] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function loadData() {
      if (!billingApi) return;
      try {
        setLoading(true);
        const [cfg, ords] = await Promise.all([
          billingApi.getConfig().catch(() => null),
          billingApi.listOrders().catch(() => ({ orders: [] })),
        ]);
        if (mounted) {
          setConfig(cfg);
          setOrders(ords?.orders || []);
        }
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadData();
    return () => {
      mounted = false;
    };
  }, [billingApi]);

  const handleCheckout = async (productCode) => {
    if (!billingApi || !config) return;
    setError(null);
    setProcessingProduct(productCode);
    try {
      const versions = {
        terms: config.policies?.terms?.version || "v1",
        privacy: config.policies?.privacy?.version || "v1",
        refund: config.policies?.refund?.version || "v1",
      };
      const res = await billingApi.startCheckout({
        productCode,
        acceptedPolicyVersions: versions,
        returnUrl: window.location.pathname + window.location.search,
      });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      }
    } catch (err) {
      setError(err.message);
      setProcessingProduct(null);
    }
  };

  const handleOpenPortal = async () => {
    if (!billingApi) return;
    setError(null);
    try {
      const res = await billingApi.openCustomerPortal({
        returnUrl: window.location.pathname + window.location.search,
      });
      if (res.portalUrl) {
        window.location.href = res.portalUrl;
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCancelSub = async () => {
    if (!billingApi) return;
    if (!confirm("Are you sure you want to cancel your subscription at the end of the current period?")) return;
    setError(null);
    try {
      await billingApi.cancelSubscription();
      setActionSuccess("Subscription scheduled for cancellation at the end of the billing period.");
      if (onRefresh) onRefresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRefund = async (orderId) => {
    if (!billingApi) return;
    if (!confirm("Request an automated refund for this pass order?")) return;
    setError(null);
    try {
      await billingApi.requestRefund({ orderId, reason: "Customer self-service refund" });
      setActionSuccess("Refund request submitted. Processing will complete shortly.");
      const ords = await billingApi.listOrders().catch(() => ({ orders: [] }));
      setOrders(ords?.orders || []);
      if (onRefresh) onRefresh();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return <div className="p-4 text-gray-400">Loading billing configuration...</div>;
  }

  const products = config?.products || [];
  const policies = config?.policies || {};

  return (
    <div className="space-y-6 text-white">
      {error && <div className="p-3 bg-red-900/50 border border-red-700 text-red-200 rounded-lg text-sm">{error}</div>}
      {actionSuccess && (
        <div className="p-3 bg-emerald-900/50 border border-emerald-700 text-emerald-200 rounded-lg text-sm">
          {actionSuccess}
        </div>
      )}

      {/* Plan selection */}
      <div>
        <h4 className="text-base font-bold mb-3">Available Plans & Passes</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {products.map((prod) => (
            <div key={prod.code} className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <h5 className="font-bold text-lg">{prod.display?.title || prod.name}</h5>
                <p className="text-2xl font-extrabold text-blue-400 mt-1">{prod.display?.priceFormatted}</p>
                <p className="text-xs text-gray-400 mt-2">{prod.display?.billingBehavior || "Full standard access"}</p>
              </div>

              <div className="mt-4 pt-3 border-t border-gray-700/60">
                <button
                  onClick={() => handleCheckout(prod.code)}
                  disabled={!agreedPolicies || processingProduct === prod.code}
                  className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed font-medium text-sm rounded-lg transition"
                >
                  {processingProduct === prod.code
                    ? "Redirecting to Checkout..."
                    : prod.code === "standard_pass_30d"
                    ? "Buy 30-Day Pass"
                    : "Subscribe"}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Policy Agreement Checkbox */}
        <div className="mt-4 flex items-start gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            id="billing-policy-agree"
            checked={agreedPolicies}
            onChange={(e) => setAgreedPolicies(e.target.checked)}
            className="mt-0.5 rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-0"
          />
          <label htmlFor="billing-policy-agree" className="cursor-pointer">
            I agree to the{" "}
            <a href={policies.terms?.url || "/terms"} target="_blank" rel="noreferrer" className="text-blue-400 underline">
              Terms of Service
            </a>
            ,{" "}
            <a href={policies.privacy?.url || "/privacy"} target="_blank" rel="noreferrer" className="text-blue-400 underline">
              Privacy Policy
            </a>
            , and 7-day{" "}
            <a href={policies.refund?.url || "/refund"} target="_blank" rel="noreferrer" className="text-blue-400 underline">
              Refund Policy
            </a>
            .
          </label>
        </div>
      </div>

      {/* Customer Portal and Subscription Cancellation */}
      <div className="pt-4 border-t border-gray-700/60 flex flex-wrap gap-3">
        <button
          onClick={handleOpenPortal}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-sm font-medium rounded-lg transition"
        >
          Manage in Stripe Portal
        </button>

        {accessState.billingStatus === "active" && (
          <button
            onClick={handleCancelSub}
            className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 border border-red-700 text-red-200 text-sm font-medium rounded-lg transition"
          >
            Cancel Subscription
          </button>
        )}
      </div>

      {/* Orders Table */}
      {orders.length > 0 && (
        <div className="pt-4 border-t border-gray-700/60">
          <h4 className="text-base font-bold mb-3">Order History</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-gray-300">
              <thead className="bg-gray-800 text-gray-400 uppercase text-xs">
                <tr>
                  <th className="p-3">Order ID</th>
                  <th className="p-3">Plan / Pass</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Date</th>
                  <th className="p-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {orders.map((ord) => {
                  const isEligibleRefund =
                    ord.status === "paid" &&
                    (ord.is_refund_eligible === 1 ||
                      ord.is_refund_eligible === true ||
                      (ord.refundable_until && ord.refundable_until > Date.now()));

                  return (
                    <tr key={ord.id} className="hover:bg-gray-800/40">
                      <td className="p-3 font-mono text-xs text-gray-400">{ord.id}</td>
                      <td className="p-3 font-medium text-white">{ord.product_code}</td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-0.5 text-xs rounded-full ${
                            ord.status === "paid"
                              ? "bg-emerald-900/60 text-emerald-300"
                              : ord.status === "refund_pending"
                              ? "bg-amber-900/60 text-amber-300"
                              : "bg-gray-700 text-gray-300"
                          }`}
                        >
                          {ord.status}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-gray-400">
                        {ord.created_at ? new Date(ord.created_at).toLocaleDateString() : "-"}
                      </td>
                      <td className="p-3">
                        {isEligibleRefund && (
                          <button
                            onClick={() => handleRefund(ord.id)}
                            className="text-xs px-2.5 py-1 bg-amber-800/50 hover:bg-amber-700 text-amber-200 rounded transition"
                          >
                            Request Refund
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
