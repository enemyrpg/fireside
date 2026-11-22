import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CopyButton } from './CopyButton';

describe('CopyButton look', () => {
  it('is filled by default, for a new API key', () => {
    render(<CopyButton value="secret-key" />);
    const button = screen.getByRole('button', { name: 'Copy' });
    expect(button.getAttribute('data-variant')).toBe('default');
  });

  it('is neutral next to other actions (two-factor key and recovery codes)', () => {
    render(<CopyButton value="ABCD EFGH" label="Copy key" look="neutral" />);
    const button = screen.getByRole('button', { name: 'Copy key' });
    expect(button.getAttribute('data-variant')).toBe('ghost');
  });
});
