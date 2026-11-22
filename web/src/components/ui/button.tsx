import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Slot } from 'radix-ui';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] text-sm font-medium whitespace-nowrap desk:rounded-lg transition-all disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // Matches docs/design.md: filled accent, accent outline, quiet ghost.
      variant: {
        default: 'bg-accent font-semibold text-on-accent hover:opacity-90',
        destructive: 'bg-down font-semibold text-on-down hover:opacity-90',
        outline: 'border border-accent text-accent-text hover:bg-accent-wash',
        secondary: 'bg-raised text-text hover:bg-hover',
        ghost: 'border border-border-strong text-text-2 hover:bg-hover hover:text-text',
        link: 'text-accent-text underline-offset-4 hover:underline',
      },
      size: {
        // 44 px on mobile, 36 px on PC.
        default: 'h-11 px-3.5 py-2 has-[>svg]:px-3 desk:h-9',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-11 gap-1.5 px-3 text-table has-[>svg]:px-2.5 desk:h-8',
        lg: 'h-11 px-6 has-[>svg]:px-4 desk:h-10',
        icon: 'size-11 desk:size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-11 desk:size-8',
        'icon-lg': 'size-11 desk:size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
