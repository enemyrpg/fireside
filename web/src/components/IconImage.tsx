import { useState } from 'react';
import { cn } from '@/lib/utils';

type Status = 'loading' | 'loaded' | 'failed';

/**
 * The real icon over a text placeholder, shared by `ItemIcon`, `SkillIcon` and
 * `BossIcon`. The placeholder shows while the image loads, and stays when there
 * is none (404) or it can't be shown. The box always has the same size, so
 * nothing moves when the image arrives. Decorative: every caller shows the name
 * next to it or in an `aria-label`, so `alt` is empty. Never ship Jagex
 * graphics in the repo: the images only live in the user's own database.
 */
export function IconImage({
  src,
  placeholder,
  width,
  height,
  title,
  boxClassName,
  placeholderClassName,
  imageClassName,
  className,
}: {
  src: string;
  /** Initials or abbreviation, shown until the image has loaded. */
  placeholder: string;
  /** Size the image is drawn at, in CSS pixels. */
  width: number;
  height: number;
  title?: string;
  /** Size, radius and text size of the box. */
  boxClassName: string;
  /** Only while the image is not shown: background and border of the placeholder. */
  placeholderClassName: string;
  /** Position and scaling of the image inside the box. */
  imageClassName: string;
  className?: string | undefined;
}) {
  // Keyed by URL, so a row that changes item, skill or boss starts over at `loading`.
  const [state, setState] = useState<{ src: string; status: Status }>({ src, status: 'loading' });
  const status: Status = state.src === src ? state.status : 'loading';
  const loaded = status === 'loaded';

  return (
    <span
      aria-hidden="true"
      {...(title === undefined ? {} : { title })}
      data-icon-status={status}
      className={cn(
        'relative inline-grid flex-none place-items-center font-semibold text-text-2',
        boxClassName,
        !loaded && placeholderClassName,
        className,
      )}
    >
      {!loaded && placeholder}
      {status !== 'failed' && (
        <img
          src={src}
          alt=""
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => {
            setState({ src, status: 'loaded' });
          }}
          onError={() => {
            setState({ src, status: 'failed' });
          }}
          className={cn('absolute', imageClassName, !loaded && 'opacity-0')}
        />
      )}
    </span>
  );
}
