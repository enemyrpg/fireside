import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ItemIcon } from './ItemIcon';

function box(container: HTMLElement): HTMLElement {
  const span = container.firstElementChild;
  if (!(span instanceof HTMLElement)) throw new Error('No icon box');
  return span;
}

describe('ItemIcon', () => {
  it('shows the placeholder while the real icon loads, with a lazy, decorative img', () => {
    const { container } = render(<ItemIcon itemId={4151} name="Abyssal whip" />);
    const span = box(container);
    expect(span).toHaveProperty('textContent', 'Ab');
    expect(span.getAttribute('aria-hidden')).toBe('true');
    expect(span.getAttribute('title')).toBe('Abyssal whip');
    expect(span.className).toContain('size-6');
    expect(span.className).toContain('border-dashed');

    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/v1/items/4151/icon');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('width')).toBe('24');
    expect(img?.getAttribute('height')).toBe('24');
    expect(img?.className).toContain('opacity-0');
  });

  it('shows the real icon once it has loaded, in the same 24 px box', () => {
    const { container } = render(<ItemIcon itemId={4151} name="Abyssal whip" />);
    const img = container.querySelector('img');
    if (!img) throw new Error('No img');
    fireEvent.load(img);
    const span = box(container);
    expect(span.dataset.iconStatus).toBe('loaded');
    expect(span.textContent).toBe('');
    expect(span.className).toContain('size-6');
    expect(span.className).not.toContain('border-dashed');
    expect(img.className).not.toContain('opacity-0');
  });

  it('keeps the placeholder when there is no icon (404) or it fails', () => {
    const { container } = render(<ItemIcon itemId={4151} name="Abyssal whip" />);
    const img = container.querySelector('img');
    if (!img) throw new Error('No img');
    fireEvent.error(img);
    const span = box(container);
    expect(span.dataset.iconStatus).toBe('failed');
    expect(container.querySelector('img')).toBeNull();
    expect(span.textContent).toBe('Ab');
    expect(span.className).toContain('border-dashed');
  });

  it('starts over when the item changes', () => {
    const { container, rerender } = render(<ItemIcon itemId={4151} name="Abyssal whip" />);
    const img = container.querySelector('img');
    if (!img) throw new Error('No img');
    fireEvent.error(img);
    rerender(<ItemIcon itemId={4152} name="Abyssal whip" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/v1/items/4152/icon');
    expect(box(container).dataset.iconStatus).toBe('loading');
  });

  it("has the game's own 36 × 32 size for slots, without a native tooltip", () => {
    const { container } = render(<ItemIcon itemId={4151} name="Abyssal whip" size="slot" />);
    const span = box(container);
    expect(span.className).toContain('w-9');
    expect(span.className).toContain('h-8');
    // The slot has its own tooltip.
    expect(span.getAttribute('title')).toBeNull();
    const img = container.querySelector('img');
    expect(img?.getAttribute('width')).toBe('36');
    expect(img?.getAttribute('height')).toBe('32');
    expect(span.textContent).toBe('Ab');
  });

  it('is exactly twice the game size with hard pixels on a pet card', () => {
    const { container } = render(<ItemIcon itemId={21992} name="Vorki" size="lg" />);
    const span = box(container);
    expect(span.className).toContain('w-18');
    expect(span.className).toContain('h-16');
    expect(span.getAttribute('title')).toBeNull();
    const img = container.querySelector('img');
    expect(img?.getAttribute('width')).toBe('72');
    expect(img?.getAttribute('height')).toBe('64');
    expect(img?.className).toContain('[image-rendering:pixelated]');
    expect(span.textContent).toBe('Vo');
  });
});
