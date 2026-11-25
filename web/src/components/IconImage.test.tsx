import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconImage } from './IconImage';

// jsdom never loads images: `complete` is true and `naturalWidth` 0. These
// tests set both to what a browser reports for a cached or a broken image.
function imageState({ complete, naturalWidth }: { complete: boolean; naturalWidth: number }) {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(complete);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(naturalWidth);
}

function renderIcon(src = '/api/v1/items/4151/icon') {
  return render(
    <IconImage
      src={src}
      placeholder="Ab"
      width={24}
      height={24}
      boxClassName="size-6"
      placeholderClassName="border-dashed"
      imageClassName="size-6"
    />,
  );
}

function box(container: HTMLElement): HTMLElement {
  const span = container.firstElementChild;
  if (!(span instanceof HTMLElement)) throw new Error('No icon box');
  return span;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IconImage', () => {
  it('starts as loaded, with no placeholder, when the browser already has the image', () => {
    imageState({ complete: true, naturalWidth: 32 });
    const { container } = renderIcon();
    const span = box(container);
    expect(span.dataset.iconStatus).toBe('loaded');
    expect(span.textContent).toBe('');
    expect(span.className).not.toContain('border-dashed');
    expect(container.querySelector('img')?.className).not.toContain('opacity-0');
  });

  it('shows the placeholder while an image that is not complete loads', () => {
    imageState({ complete: false, naturalWidth: 0 });
    const { container } = renderIcon();
    expect(box(container).dataset.iconStatus).toBe('loading');
    expect(box(container).textContent).toBe('Ab');
  });

  it('does not take a complete but broken image (no size) as loaded', () => {
    imageState({ complete: true, naturalWidth: 0 });
    const { container } = renderIcon();
    expect(box(container).dataset.iconStatus).toBe('loading');
    expect(box(container).textContent).toBe('Ab');
  });

  it('still falls back to the placeholder when the image fails', () => {
    imageState({ complete: false, naturalWidth: 0 });
    const { container } = renderIcon();
    const img = container.querySelector('img');
    if (!img) throw new Error('No img');
    fireEvent.error(img);
    const span = box(container);
    expect(span.dataset.iconStatus).toBe('failed');
    expect(container.querySelector('img')).toBeNull();
    expect(span.textContent).toBe('Ab');
    expect(span.className).toContain('border-dashed');
  });

  it('checks again when the image changes', () => {
    imageState({ complete: false, naturalWidth: 0 });
    const { container, rerender } = renderIcon('/api/v1/items/1/icon');
    expect(box(container).dataset.iconStatus).toBe('loading');
    imageState({ complete: true, naturalWidth: 32 });
    rerender(
      <IconImage
        src="/api/v1/items/2/icon"
        placeholder="Ab"
        width={24}
        height={24}
        boxClassName="size-6"
        placeholderClassName="border-dashed"
        imageClassName="size-6"
      />,
    );
    expect(box(container).dataset.iconStatus).toBe('loaded');
  });
});
