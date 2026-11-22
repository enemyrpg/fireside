import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BossIcon } from './BossIcon';

function box(container: HTMLElement): HTMLElement {
  const span = container.firstElementChild;
  if (!(span instanceof HTMLElement)) throw new Error('No icon box');
  return span;
}

function image(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector('img');
  if (!img) throw new Error('No img');
  return img;
}

describe('BossIcon', () => {
  it('shows the initials while the real icon loads, with a lazy, decorative img', () => {
    const { container } = render(<BossIcon boss="Chambers of Xeric" />);
    const span = box(container);
    expect(span.textContent).toBe('COX');
    expect(span.getAttribute('aria-hidden')).toBe('true');
    expect(span.dataset.iconStatus).toBe('loading');
    expect(span.className).toContain('size-6');
    expect(span.className).toContain('bg-raised');
    expect(span.className).not.toContain('border-dashed');

    const img = image(container);
    expect(img.getAttribute('src')).toBe('/api/v1/bosses/Chambers%20of%20Xeric/icon');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.className).toContain('opacity-0');
  });

  it('sends a raid mode as it is: the server falls back to the raid', () => {
    const { container } = render(<BossIcon boss="Theatre of Blood: Entry Mode" />);
    expect(image(container).getAttribute('src')).toBe(
      '/api/v1/bosses/Theatre%20of%20Blood%3A%20Entry%20Mode/icon',
    );
    expect(box(container).textContent).toBe('TOB');
  });

  it('draws the 25 × 25 sprite unscaled, centred in the 24 × 24 box', () => {
    const { container } = render(<BossIcon boss="Vorkath" />);
    const span = box(container);
    const img = image(container);
    expect(span.className).toContain('size-6');
    expect(span.className).not.toContain('overflow-hidden');
    expect(img.getAttribute('width')).toBe('25');
    expect(img.getAttribute('height')).toBe('25');
    expect(img.className).toContain('size-[25px]');
    expect(img.className).toContain('-left-[0.5px]');
    expect(img.className).toContain('-top-[0.5px]');
    expect(img.className).toContain('max-w-none');
    expect(img.className).toContain('[image-rendering:pixelated]');
    expect(img.className).not.toContain('object-contain');
    expect(img.className).not.toContain('size-full');
  });

  it('shows the real icon once it has loaded, in the same 24 px box', () => {
    const { container } = render(<BossIcon boss="Vorkath" />);
    fireEvent.load(image(container));
    const span = box(container);
    expect(span.dataset.iconStatus).toBe('loaded');
    expect(span.textContent).toBe('');
    expect(span.className).toContain('size-6');
    expect(span.className).not.toContain('bg-raised');
    expect(image(container).className).not.toContain('opacity-0');
  });

  it('keeps the initials when there is no icon (404) or it fails', () => {
    const { container } = render(<BossIcon boss="Vorkath" />);
    fireEvent.error(image(container));
    const span = box(container);
    expect(span.dataset.iconStatus).toBe('failed');
    expect(container.querySelector('img')).toBeNull();
    expect(span.textContent).toBe('Vo');
    expect(span.className).toContain('bg-raised');
  });

  it('starts over when the boss changes', () => {
    const { container, rerender } = render(<BossIcon boss="Vorkath" />);
    fireEvent.error(image(container));
    rerender(<BossIcon boss="Zulrah" />);
    expect(image(container).getAttribute('src')).toBe('/api/v1/bosses/Zulrah/icon');
    expect(box(container).dataset.iconStatus).toBe('loading');
  });

  it('is exactly twice the sprite size with hard pixels when large', () => {
    const { container } = render(<BossIcon boss="Vorkath" size="lg" />);
    const span = box(container);
    expect(span.className).toContain('size-[50px]');
    const img = image(container);
    expect(img.getAttribute('width')).toBe('50');
    expect(img.getAttribute('height')).toBe('50');
    expect(img.className).toContain('[image-rendering:pixelated]');
    expect(span.textContent).toBe('Vo');
  });
});
