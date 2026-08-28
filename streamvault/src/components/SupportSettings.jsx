import React, { useState, useEffect } from "react";

export default function SupportSettings({ billingApi }) {
  const [tickets, setTickets] = useState([]);
  const [category, setCategory] = useState("billing_refund");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function loadTickets() {
      if (!billingApi) return;
      try {
        setLoading(true);
        const res = await billingApi.listTickets();
        if (mounted) setTickets(res?.tickets || []);
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadTickets();
    return () => {
      mounted = false;
    };
  }, [billingApi]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!billingApi) return;
    if (message.trim().length < 10) {
      setError("Message must be at least 10 characters.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await billingApi.createTicket({
        category,
        message: message.trim(),
      });
      setSuccess(`Support ticket #${res.ticketId} created successfully! Our team will respond shortly.`);
      setMessage("");
      const updated = await billingApi.listTickets();
      setTickets(updated?.tickets || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 text-white">
      {error && <div className="p-3 bg-red-900/50 border border-red-700 text-red-200 rounded-lg text-sm">{error}</div>}
      {success && (
        <div className="p-3 bg-emerald-900/50 border border-emerald-700 text-emerald-200 rounded-lg text-sm">
          {success}
        </div>
      )}

      {/* Ticket creation form */}
      <form onSubmit={handleSubmit} className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4">
        <h4 className="text-base font-bold">Contact Support</h4>

        <div>
          <label htmlFor="support-category" className="block text-xs font-semibold text-gray-300 uppercase mb-1">
            Category
          </label>
          <select
            id="support-category"
            aria-label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500"
          >
            <option value="billing_refund">Billing & Refund</option>
            <option value="payment_failed">Payment Issue</option>
            <option value="account">Account & Security</option>
            <option value="technical">Technical & Playback</option>
            <option value="other">Other Inquiry</option>
          </select>
        </div>

        <div>
          <label htmlFor="support-message" className="block text-xs font-semibold text-gray-300 uppercase mb-1">
            Message
          </label>
          <div className="text-xs text-amber-300/90 bg-amber-950/30 border border-amber-800/40 rounded-lg p-2.5 mb-2 leading-relaxed">
            Never include credit card numbers, passwords, streaming URLs with credentials, or tokens in support requests.
          </div>
          <textarea
            id="support-message"
            aria-label="Message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Describe your issue or question in detail (minimum 10 characters, maximum 2000 characters)..."
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500 resize-y"
          />
          <div className="text-right text-xs text-gray-400 mt-1">{message.length} / 2000 characters</div>
        </div>

        <button
          type="submit"
          disabled={submitting || message.trim().length < 10 || message.length > 2000}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed font-medium text-sm rounded-lg transition"
        >
          {submitting ? "Submitting..." : "Submit Support Ticket"}
        </button>
      </form>

      {/* Ticket List */}
      <div>
        <h4 className="text-base font-bold mb-3">Your Support Tickets</h4>
        {loading ? (
          <div className="text-gray-400 text-sm">Loading tickets...</div>
        ) : tickets.length === 0 ? (
          <div className="text-gray-400 text-sm bg-gray-800/40 p-4 rounded-xl border border-gray-700/60">
            No support tickets submitted yet.
          </div>
        ) : (
          <div className="space-y-3">
            {tickets.map((tkt) => (
              <div key={tkt.id} className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span className="font-mono font-bold text-gray-300">#{tkt.id}</span>
                  <span
                    className={`px-2 py-0.5 rounded-full font-medium ${
                      tkt.status === "open"
                        ? "bg-blue-900/60 text-blue-300"
                        : tkt.status === "resolved"
                        ? "bg-emerald-900/60 text-emerald-300"
                        : "bg-gray-700 text-gray-300"
                    }`}
                  >
                    {tkt.status}
                  </span>
                </div>
                <p className="text-sm text-gray-200">{tkt.message}</p>
                <div className="text-xs text-gray-400 pt-2 border-t border-gray-700/50 flex justify-between">
                  <span className="capitalize">Category: {tkt.category}</span>
                  <span>{tkt.created_at ? new Date(tkt.created_at).toLocaleDateString() : ""}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
