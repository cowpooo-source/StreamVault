import React from "react";

export default function AccountStatusCard({ accessState = {}, onManageBilling, onOpenUpgrade }) {
  const role = accessState.role || "free";
  const plan = accessState.plan || "free";
  const billingStatus = accessState.billingStatus || "none";
  const limits = accessState.limits || { maxConnections: 2, maxLogins: 1 };
  const endsAt = accessState.accessEndsAt ? new Date(accessState.accessEndsAt).toLocaleDateString() : null;

  const isPaid = role === "pro" || role === "regular" || plan === "standard";
  const isGrace = billingStatus === "grace";

  let badgeColor = "bg-gray-700 text-gray-200";
  let badgeLabel = "Free";

  if (role === "pro") {
    badgeColor = "bg-purple-600 text-white";
    badgeLabel = "Pro";
  } else if (isGrace) {
    badgeColor = "bg-amber-600 text-white";
    badgeLabel = "Grace Period";
  } else if (isPaid) {
    badgeColor = "bg-blue-600 text-white";
    badgeLabel = "Standard";
  }

  return (
    <div className="bg-gray-800/80 border border-gray-700 rounded-xl p-5 shadow-lg text-white">
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className={`px-2.5 py-1 text-xs font-semibold rounded-full uppercase tracking-wider ${badgeColor}`}>
            {badgeLabel}
          </span>
          <h3 className="text-lg font-bold mt-2">
            {role === "pro" ? "Pro Plan" : isPaid ? "Standard Plan" : "Free Plan"}
          </h3>
        </div>
        <div>
          {isPaid ? (
            <button
              onClick={onManageBilling}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-sm font-medium rounded-lg transition"
            >
              Manage Billing
            </button>
          ) : (
            <button
              onClick={onOpenUpgrade}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-sm font-medium rounded-lg transition"
            >
              Upgrade Plan
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm text-gray-300 pt-3 border-t border-gray-700/60">
        <div>
          <p className="text-gray-400 text-xs uppercase font-medium">Limits</p>
          <p className="font-semibold">{limits.maxConnections} Connections</p>
        </div>
        <div>
          <p className="text-gray-400 text-xs uppercase font-medium">Logins</p>
          <p className="font-semibold">{limits.maxLogins || 1} Active Sessions</p>
        </div>
        {endsAt && (
          <div>
            <p className="text-gray-400 text-xs uppercase font-medium">Access Through</p>
            <p className="font-semibold">{endsAt}</p>
          </div>
        )}
      </div>
    </div>
  );
}
