import { ChevronRightIcon } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';

export interface CollapsibleSectionProps {
  title: string;
  /** Shown after the title: how many rows the section has. */
  count: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A section of a card that folds: a heading with an arrow and a count. The
 * button carries `aria-expanded`. The heading is a 44 px box (48 on mobile)
 * in `--raised` with the count on the right, and the sections stand 6 px apart.
 */
export function CollapsibleSection({
  title,
  count,
  open,
  onOpenChange,
  children,
}: CollapsibleSectionProps) {
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} className="flex flex-col">
      <h3 className="m-0 text-sm">
        <Collapsible.Trigger className="group flex h-12 w-full cursor-pointer items-center gap-2.5 rounded-[10px] border border-border bg-raised px-3.5 text-left font-normal text-text hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent desk:h-11">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 flex-none text-text-3 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          />
          {title}
          <span className="ml-auto text-text-3 tabular-nums">{count}</span>
        </Collapsible.Trigger>
      </h3>
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
