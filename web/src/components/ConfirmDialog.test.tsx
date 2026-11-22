import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubDesktop } from '@/test/render-app';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(props: { pending?: boolean; field?: boolean } = {}) {
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Rename admin?"
      description="Pick a new name."
      confirmLabel="Rename"
      pendingLabel="Renaming…"
      pending={props.pending ?? false}
      onConfirm={() => undefined}
    >
      {props.field === false ? undefined : <input aria-label="New name" />}
    </ConfirmDialog>,
  );
  return { onOpenChange };
}

function backdrop(): Element {
  const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]');
  if (!overlay) throw new Error('No backdrop');
  return overlay;
}

describe('ConfirmDialog', () => {
  it('starts in its field on PC', async () => {
    stubDesktop();
    open();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('New name'));
    });
  });

  it('starts on its title as a sheet on mobile, so the keyboard stays closed', async () => {
    open();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Rename admin?' }));
    });
  });

  it('starts on Cancel without a field, on PC and mobile', async () => {
    open({ field: false });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    });
  });

  it('closes when the backdrop is tapped on mobile', async () => {
    const { onOpenChange } = open();
    await userEvent.click(backdrop());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open on a backdrop tap while the action runs', async () => {
    const { onOpenChange } = open({ pending: true });
    await userEvent.click(backdrop());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('needs an answer on PC: a click on the backdrop does nothing', async () => {
    stubDesktop();
    const { onOpenChange } = open();
    await userEvent.click(backdrop());
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
