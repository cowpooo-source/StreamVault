import React, { useState } from "react";
import { createPortal } from "react-dom";
import AccountStatusCard from "./AccountStatusCard.jsx";
import BillingSettings from "./BillingSettings.jsx";
import SupportSettings from "./SupportSettings.jsx";

export default function AccountSettingsModal(props) {
  if (!props.isOpen) return null;

  return createPortal(
    <AccountSettingsModalPanel key={props.initialTab || "account"} {...props} />,
    document.body
  );
}

function AccountSettingsModalPanel({
  onClose,
  initialTab = "account",
  accessState = {},
  billingApi,
  user = {},
  onRefresh,
}) {
  const [activeTab, setActiveTab] = useState(initialTab);

  return (
    <div
      className="account-settings-overlay"
      onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
    >
      <div className="account-settings-modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
        {/* Modal Header */}
        <div className="account-settings-header">
          <h2 id="account-settings-title" className="account-settings-title">Account & Billing Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="account-settings-close"
          >
            &times;
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="account-settings-tabs" role="tablist" aria-label="Account settings sections">
          <button
            role="tab"
            aria-selected={activeTab === "account"}
            onClick={() => setActiveTab("account")}
            className={`account-settings-tab ${activeTab === "account" ? "is-active" : ""}`}
          >
            Account
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "billing"}
            onClick={() => setActiveTab("billing")}
            className={`account-settings-tab ${activeTab === "billing" ? "is-active" : ""}`}
          >
            Billing
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "connections"}
            onClick={() => setActiveTab("connections")}
            className={`account-settings-tab ${activeTab === "connections" ? "is-active" : ""}`}
          >
            Connections
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "support"}
            onClick={() => setActiveTab("support")}
            className={`account-settings-tab ${activeTab === "support" ? "is-active" : ""}`}
          >
            Support
          </button>
        </div>

        {/* Modal Body */}
        <div className="account-settings-body">
          {activeTab === "account" && (
            <div className="space-y-6">
              <AccountStatusCard
                accessState={accessState}
                onOpenUpgrade={() => setActiveTab("billing")}
                onManageBilling={() => setActiveTab("billing")}
              />

              <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 text-white">
                <h4 className="font-bold text-base mb-2">User Profile</h4>
                <div className="space-y-1 text-sm text-gray-300">
                  <p>
                    <span className="text-gray-400">Username:</span> {user.username || "—"}
                  </p>
                  <p>
                    <span className="text-gray-400">Email:</span> {user.email || "Not configured"}
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === "billing" && (
            <BillingSettings billingApi={billingApi} accessState={accessState} onRefresh={onRefresh} />
          )}

          {activeTab === "connections" && (
            <div className="space-y-4 text-white">
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
                <h4 className="font-bold text-base mb-1">Active Connections & Limits</h4>
                <p className="text-xs text-gray-400 mb-4">
                  Your plan allows up to {accessState.limits?.maxConnections || 2} simultaneous active connections.
                </p>
                <div className="text-sm text-gray-300">
                  <p className="font-medium text-emerald-400">
                    &bull; Plan Slots: {accessState.limits?.maxConnections || 2} allowed
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === "support" && <SupportSettings billingApi={billingApi} />}
        </div>
      </div>
    </div>
  );
}
