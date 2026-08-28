import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SupportSettings from "../src/components/SupportSettings.jsx";

describe("SupportSettings Component", () => {
  let mockBillingApi;

  beforeEach(() => {
    mockBillingApi = {
      listTickets: vi.fn().mockResolvedValue({
        tickets: [
          {
            id: "tkt_1",
            category: "playback",
            message: "Stream lag on channel 4.",
            status: "open",
            created_at: Date.now() - 3600000,
          },
        ],
      }),
      createTicket: vi.fn().mockResolvedValue({
        ticketId: "tkt_new",
        status: "open",
      }),
    };
  });

  it("renders ticket list and allows submitting a new ticket", async () => {
    render(<SupportSettings billingApi={mockBillingApi} />);

    await waitFor(() => {
      expect(screen.getByText(/Stream lag on channel 4/i)).toBeDefined();
    });

    const categorySelect = screen.getByLabelText(/Category/i);
    fireEvent.change(categorySelect, { target: { value: "billing_refund" } });

    const messageInput = screen.getByLabelText(/Message/i);
    fireEvent.change(messageInput, { target: { value: "I need help with my annual subscription charge." } });

    const submitBtn = screen.getByRole("button", { name: /Submit Support Ticket/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockBillingApi.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "billing_refund",
          message: "I need help with my annual subscription charge.",
        })
      );
    });
  });
});
