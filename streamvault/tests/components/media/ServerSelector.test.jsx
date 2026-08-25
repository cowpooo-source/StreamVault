import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ServerSelector } from '../../../src/components/media/ServerSelector.jsx';

describe('ServerSelector', () => {
  it('should render Jellyfin and Plex buttons', () => {
    render(<ServerSelector onSelect={vi.fn()} />);
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();
    expect(screen.getByText('Plex')).toBeInTheDocument();
  });

  it('should call onSelect with jellyfin when Jellyfin button is clicked', () => {
    const onSelect = vi.fn();
    render(<ServerSelector onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Jellyfin'));
    expect(onSelect).toHaveBeenCalledWith('jellyfin');
  });

  it('should call onSelect with plex when Plex button is clicked', () => {
    const onSelect = vi.fn();
    render(<ServerSelector onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Plex'));
    expect(onSelect).toHaveBeenCalledWith('plex');
  });
});