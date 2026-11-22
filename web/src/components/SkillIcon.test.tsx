import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SkillIcon } from './SkillIcon';

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

describe('SkillIcon', () => {
  it('shows the abbreviation while the real icon loads, with a lazy, decorative img', () => {
    const { container } = render(<SkillIcon skill="RUNECRAFT" />);
    const span = box(container);
    expect(span.textContent).toBe('RC');
    expect(span.getAttribute('aria-hidden')).toBe('true');
    expect(span.dataset.iconStatus).toBe('loading');
    expect(span.className).toContain('size-6');
    expect(span.className).toContain('bg-raised');
    expect(span.className).not.toContain('border-dashed');

    const img = image(container);
    expect(img.getAttribute('src')).toBe('/api/v1/skills/RUNECRAFT/icon');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.className).toContain('opacity-0');
  });

  it('draws the 25 × 25 sprite unscaled, centred in the 24 × 24 box', () => {
    const { container } = render(<SkillIcon skill="ATTACK" />);
    const span = box(container);
    const img = image(container);
    // The box keeps its 24 px, and does not clip the half pixel on each side.
    expect(span.className).toContain('size-6');
    expect(span.className).not.toContain('overflow-hidden');
    expect(img.getAttribute('width')).toBe('25');
    expect(img.getAttribute('height')).toBe('25');
    expect(img.className).toContain('size-[25px]');
    expect(img.className).toContain('-left-[0.5px]');
    expect(img.className).toContain('-top-[0.5px]');
    expect(img.className).toContain('max-w-none');
    expect(img.className).toContain('[image-rendering:pixelated]');
    // Never scaled to fit.
    expect(img.className).not.toContain('object-contain');
    expect(img.className).not.toContain('size-full');
  });

  it('shows the real icon once it has loaded, in the same 24 px box', () => {
    const { container } = render(<SkillIcon skill="ATTACK" />);
    fireEvent.load(image(container));
    const span = box(container);
    expect(span.dataset.iconStatus).toBe('loaded');
    expect(span.textContent).toBe('');
    expect(span.className).toContain('size-6');
    expect(span.className).not.toContain('bg-raised');
    expect(image(container).className).not.toContain('opacity-0');
  });

  it('keeps the abbreviation when there is no icon (404) or it fails', () => {
    const { container } = render(<SkillIcon skill="ATTACK" />);
    fireEvent.error(image(container));
    const span = box(container);
    expect(span.dataset.iconStatus).toBe('failed');
    expect(container.querySelector('img')).toBeNull();
    expect(span.textContent).toBe('At');
    expect(span.className).toContain('bg-raised');
  });

  it('starts over when the skill changes', () => {
    const { container, rerender } = render(<SkillIcon skill="ATTACK" />);
    fireEvent.error(image(container));
    rerender(<SkillIcon skill="MAGIC" />);
    expect(image(container).getAttribute('src')).toBe('/api/v1/skills/MAGIC/icon');
    expect(box(container).dataset.iconStatus).toBe('loading');
    expect(box(container).textContent).toBe('Ma');
  });

  it('uses OVERALL for the total level, and takes unknown skills as they are', () => {
    const overall = render(<SkillIcon skill="OVERALL" />);
    expect(image(overall.container).getAttribute('src')).toBe('/api/v1/skills/OVERALL/icon');
    expect(box(overall.container).textContent).toBe('All');
    const unknown = render(<SkillIcon skill="NEW_SKILL" />);
    expect(image(unknown.container).getAttribute('src')).toBe('/api/v1/skills/NEW_SKILL/icon');
  });

  it('is exactly twice the sprite size with hard pixels when large', () => {
    const { container } = render(<SkillIcon skill="ATTACK" size="lg" />);
    const span = box(container);
    expect(span.className).toContain('size-[50px]');
    const img = image(container);
    expect(img.getAttribute('width')).toBe('50');
    expect(img.getAttribute('height')).toBe('50');
    expect(img.className).toContain('[image-rendering:pixelated]');
    expect(span.textContent).toBe('At');
  });
});
