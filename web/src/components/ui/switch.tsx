import * as React from 'react';
import { cn } from '@/lib/utils';
import { Switch as SwitchPrimitive } from 'radix-ui';

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // No `outline-none` or `outline-hidden` here: both set the outline style to none, and
        // `focus-visible:outline-2` only sets the width, so the focus ring would never show.
        // The area before it makes the touch target 44 px on mobile.
        'peer relative inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer items-center rounded-full bg-afk transition-colors before:absolute before:-inset-x-[7px] before:-inset-y-[13px] before:content-[""] desk:before:hidden focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent motion-reduce:transition-none',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-on-accent transition-transform data-[state=checked]:translate-x-3.5 motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
