import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getAppHomeUrl } from "../direct-content-session.js";
import { COMPARE_PLANS } from "./comparePlansData.js";

function isCurrentPlan(planId, currentPlan) {
  if (planId === "standard") return currentPlan === "standard" || currentPlan === "regular";
  return planId === currentPlan;
}

export default function ComparePlansDialog({
  isOpen,
  onClose,
  currentPlan = "free",
  contentMode = false,
  onSelectPlan,
  onOpenSecure,
}) {
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    previousFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  function handleStandardAction() {
    if (contentMode) {
      if (onOpenSecure) {
        onOpenSecure("billing");
      } else {
        const target = new URL(getAppHomeUrl());
        target.searchParams.set("section", "settings");
        target.searchParams.set("settingsTab", "billing");
        window.location.assign(target.toString());
      }
      return;
    }
    onSelectPlan?.("standard");
  }

  return createPortal(
    <div
      className="compare-plans-overlay"
      data-testid="compare-plans-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        className="compare-plans-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-plans-title"
        aria-describedby="compare-plans-description"
      >
        <div className="compare-plans-header">
          <div>
            <h2 id="compare-plans-title" className="compare-plans-title">Compare Plans</h2>
            <p id="compare-plans-description" className="compare-plans-subtitle">
              Compare access, limits, and account features.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="compare-plans-close"
            onClick={onClose}
            aria-label="Close plan comparison"
          >
            &times;
          </button>
        </div>

        {contentMode && (
          <div className="compare-plans-security-note">
            HTTP content mode is read-only. Account and billing actions continue on the secure app.
          </div>
        )}

        <div className="compare-plans-body">
          <div className="compare-plans-grid">
            {COMPARE_PLANS.map((plan) => {
              const current = isCurrentPlan(plan.id, currentPlan);
              const standard = plan.id === "standard";
              const pro = plan.id === "pro";
              const features = [
                plan.account,
                plan.catalog,
                plan.watchTime,
                plan.connections,
                plan.sessions,
                plan.ads,
                plan.sync,
                plan.support,
              ];

              return (
                <section
                  key={plan.id}
                  className={"compare-plan-card" + (standard ? " is-popular" : "") + (pro ? " is-disabled" : "")}
                  aria-label={plan.name + " plan"}
                >
                  <div className="plan-card-header">
                    <div className="plan-card-header-row">
                      <h3 className="plan-name">{plan.name}</h3>
                      <span className={"plan-badge " + (standard ? "badge-success" : pro ? "badge-warning" : "badge-neutral")}>
                        {plan.badge}
                      </span>
                    </div>
                    <div className="plan-price-block">
                      <span className="plan-price">{plan.price}</span>
                    </div>
                    <div className="plan-period-info">{plan.period}</div>
                    {plan.pricingDetails && (
                      <div className="plan-pricing-breakdown">
                        {plan.pricingDetails.map((detail) => <div key={detail}>- {detail}</div>)}
                      </div>
                    )}
                  </div>

                  <div className="plan-features-list">
                    {features.map((feature) => (
                      <div key={feature} className="plan-feature-item">
                        <span className="feature-icon" aria-hidden="true">+</span>
                        <span className="feature-text">{feature}</span>
                      </div>
                    ))}
                  </div>

                  <div className="plan-card-footer">
                    {standard ? (
                      <button type="button" className="btn-plan-cta btn-plan-primary" onClick={handleStandardAction}>
                        {contentMode ? "Upgrade on Secure App" : current ? "Manage Plan" : "Upgrade to Standard"}
                      </button>
                    ) : (
                      <button type="button" className="btn-plan-cta btn-plan-disabled" disabled aria-disabled="true">
                        {pro ? "Coming Soon" : current ? "Current Plan" : "Free"}
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          <p className="compare-plans-disclaimer">
            Guest and Free catalog values of 5,000 per category and watch time of 3 hours/day are display-only and are not enforced yet.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
