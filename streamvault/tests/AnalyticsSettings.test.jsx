import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/app-runtime.js', () => ({
  db: { get: vi.fn(async (_key, fallback) => fallback) },
}));

describe('analytics preference settings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-TEST123');
    localStorage.clear();
    localStorage.getItem.mockReturnValue(null);
  });

  it('shows an unselected state and lets the user change consent later', async () => {
    const { default: SettingsView } = await import('../src/components/SettingsView.jsx');
    render(<SettingsView connections={[]} authUser={null} activeConnId={null} autoLoadMore={false} setAutoLoadMore={vi.fn()} />);

    expect(screen.getByText(/Consent:.*Not selected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow analytics' }));
    expect(localStorage.setItem).toHaveBeenCalledWith('sv-analytics-consent', 'granted');
    expect(screen.getByText(/Consent:.*Enabled/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disable analytics' }));
    expect(localStorage.setItem).toHaveBeenCalledWith('sv-analytics-consent', 'denied');
    expect(screen.getByText(/Consent:.*Disabled/)).toBeInTheDocument();
  });
});
