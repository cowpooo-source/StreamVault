import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import VirtualGrid from '../src/components/VirtualGrid.jsx';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }) => ({
    getVirtualItems: () => count ? [{ index: count - 1, start: 0, size: 285 }] : [],
    getTotalSize: () => count * 285,
  }),
}));

describe('VirtualGrid pagination', () => {
  it('does not request another page during the initial render', async () => {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    const onEndReached = vi.fn();
    render(
      <VirtualGrid
        items={[{ id: '1', name: 'Movie', type: 'vod' }]}
        section="vod"
        isFav={() => false}
        historyMap={new Map()}
        playItem={vi.fn()}
        toggleFav={vi.fn()}
        setExpandedItem={vi.fn()}
        imgSrc={() => ''}
        canLoadMore
        onEndReached={onEndReached}
      />,
    );

    expect(onEndReached).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(onEndReached).toHaveBeenCalledTimes(1));
  });
});
