import React, { useState } from "react";
import { createPortal } from "react-dom";
import AccountStatusCard from "./AccountStatusCard.jsx";
import BillingSettings from "./BillingSettings.jsx";
import SupportSettings from "./SupportSettings.jsx";

export default function AccountSettingsModal({
  isOpen,
  onClose,
  initialTab = "account",
  accessState = {},
  billingApi,
  user = {},
  onRefresh,
}) {
  const [activeTab, setActiveTab] = useState(initialTab);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      style={{ position: "fixed", inset: 0, zIndex: 99999 }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-xl font-bold text-white">Account & Billing Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-white text-2xl font-bold p-1 leading-none rounded-lg hover:bg-gray-800 transition"
          >
            &times;
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-800 px-6 bg-gray-950/40" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "account"}
            onClick={() => setActiveTab("account")}
            className={`py-3 px-4 text-sm font-semibold border-b-2 transition ${
              activeTab === "account"
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            Account
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "billing"}
            onClick={() => setActiveTab("billing")}
            className={`py-3 px-4 text-sm font-semibold border-b-2 transition ${
              activeTab === "billing"
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            Billing
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "connections"}
            onClick={() => setActiveTab("connections")}
            className={`py-3 px-4 text-sm font-semibold border-b-2 transition ${
              activeTab === "connections"
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            Connections
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "support"}
            onClick={() => setActiveTab("support")}
            className={`py-3 px-4 text-sm font-semibold border-b-2 transition ${
              activeTab === "support"
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            Support
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 bg-gray-900/90">
          {activeTab === "account" && (
            <div className="space-y-6">
              <AccountStatusCard access={accessState} onOpenBilling={() => setActiveTab("billing")} />

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
    </div>,
    document.body
  );
}
