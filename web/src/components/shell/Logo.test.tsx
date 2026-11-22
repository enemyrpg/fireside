import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { logoSvg } from '@/branding/logo';
import { Logo } from './Logo';

/** The drawing without colours: each element's tag and geometry attributes. */
function shape(svg: Element) {
  const geometry = ['d', 'width', 'height', 'rx'];
  return {
    viewBox: svg.getAttribute('viewBox'),
    strokeWidth: svg.getAttribute('stroke-width'),
    linecap: svg.getAttribute('stroke-linecap'),
    linejoin: svg.getAttribute('stroke-linejoin'),
    children: Array.from(svg.children).map((child) => ({
      tag: child.tagName.toLowerCase(),
      ...Object.fromEntries(geometry.map((name) => [name, child.getAttribute(name)])),
      filled: child.getAttribute('fill') !== null && child.getAttribute('fill') !== 'none',
    })),
  };
}

describe('Logo', () => {
  it('draws the same shapes as the logo files and favicon (logo.ts)', () => {
    const { container } = render(<Logo />);
    const rendered = container.querySelector('svg');
    const file = new DOMParser().parseFromString(logoSvg(), 'image/svg+xml').documentElement;
    expect(rendered).not.toBeNull();
    if (rendered) expect(shape(rendered)).toEqual(shape(file));
  });

  it('follows the theme: square in --accent, strokes in --on-accent', () => {
    const { container } = render(<Logo />);
    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('var(--on-accent)');
    expect(container.querySelector('rect')?.getAttribute('fill')).toBe('var(--accent)');
  });
});
