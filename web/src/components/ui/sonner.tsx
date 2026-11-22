import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { THEMES } from '@/theme/themes';
import { useTheme } from '@/theme/useTheme';

// Changed from shadcn's version: follows our theme (themes.ts) instead of next-themes.
function Toaster(props: ToasterProps) {
  const [theme] = useTheme();

  return (
    <Sonner
      theme={THEMES.find((item) => item.id === theme)?.scheme ?? 'dark'}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--card)',
          '--normal-text': 'var(--text)',
          '--normal-border': 'var(--border)',
          '--border-radius': '10px',
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
