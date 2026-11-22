import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/api/query-client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { mockApi } from '@/test/render-app';
import { SessionTimeline } from './SessionTimeline';

const drop = (id: number, occurredAt: string, geValue: number) => ({
  id,
  occurredAt,
  geValue,
  source: { type: 'NPC' as const, name: 'Vorkath' },
  killCount: null,
});

/** jsdom has no layout: give the timeline a width, as `ResizeObserver` would. */
function withWidth(width: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
  } as DOMRect);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const clogItem = (itemId: number, at: string, approximate = false) => ({
  itemId,
  name: `Item ${String(itemId)}`,
  page: 'Vorkath',
  at,
  approximate,
});

function renderTimeline(
  live: boolean,
  {
    clogItems,
    startedAt = '2026-11-08T18:00:00.000Z',
    end = '2026-11-08T20:00:00.000Z',
  }: { clogItems?: ReturnType<typeof clogItem>[]; startedAt?: string; end?: string } = {},
) {
  mockApi();
  const client = createQueryClient();
  // Health (time zone) already loaded: Europe/Oslo, UTC+1 in November.
  client.setQueryData(['health'], {
    status: 'ok',
    serverVersion: '0',
    contractVersion: '0',
    timeZone: 'Europe/Oslo',
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SessionTimeline
          startedAt={startedAt}
          endMs={Date.parse(end)}
          live={live}
          afkPeriods={[
            { startedAt: '2026-11-08T18:30:00.000Z', endedAt: '2026-11-08T19:00:00.000Z' },
          ]}
          loot={[
            drop(1, '2026-11-08T18:10:00.000Z', 120_000),
            drop(2, '2026-11-08T19:30:00.000Z', 2_850_000),
          ]}
          {...(clogItems === undefined ? {} : { clogItems })}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('SessionTimeline', () => {
  it('places AFK, drops (1M+ highlighted) and local clock times', () => {
    withWidth(800);
    renderTimeline(false);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toBe(
      'Session timeline, 2 h, 1 AFK period, 2 drops (1 worth 1M+ gp)',
    );
    const afk = screen.getByTestId('afk-period');
    expect(afk.style.left).toBe('25%');
    expect(afk.style.width).toBe('25%');
    // The active stretches around it can be hovered too.
    const active = screen.getAllByTestId('active-period');
    expect(active.map((segment) => [segment.style.left, segment.style.width])).toEqual([
      ['0%', '25%'],
      ['50%', '50%'],
    ]);
    expect(screen.getAllByTestId('drop-marker')).toHaveLength(1);
    expect(screen.getByTestId('drop-marker-big').style.left).toBe('75%');
    // 19:00–21:00 local, ticks every 30 min, ends labelled.
    expect(img.textContent).toBe('19:0019:3020:0020:3021:00');
  });

  it('shows only the start and end labels until the width is known', () => {
    renderTimeline(false);
    expect(screen.getByRole('img').textContent).toBe('19:0021:00');
  });

  it('keeps tick labels clear of the start and end labels on a phone', () => {
    // The issue's session, 20:19–22:37 local, about 360 px wide.
    withWidth(360);
    renderTimeline(false, {
      startedAt: '2026-11-08T19:19:00.000Z',
      end: '2026-11-08T21:37:00.000Z',
    });
    expect(screen.getByRole('img').textContent).toBe('20:1921:0021:3022:0022:37');
  });

  it('marks new collection log items, an approximate one outlined at the end', () => {
    withWidth(800);
    renderTimeline(false, {
      clogItems: [
        clogItem(1, '2026-11-08T19:00:00.000Z'),
        clogItem(2, '2026-11-08T20:02:30.000Z', true),
      ],
    });
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Session timeline, 2 h, 1 AFK period, 2 drops (1 worth 1M+ gp), 2 new collection log items',
    );
    expect(screen.getByTestId('clog-marker').style.left).toBe('50%');
    expect(screen.getByTestId('clog-marker-approximate').style.left).toBe('100%');
  });

  it('says "now" at the end of an open session', () => {
    renderTimeline(true);
    expect(screen.getByRole('img').textContent).toMatch(/now$/);
  });
});
