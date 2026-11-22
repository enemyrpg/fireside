/**
 * Edge padding that lines the top bar and the footer up with the content
 * (max 1376 px with 32 px padding on PC), and keeps them clear of a notch
 * (`safe-x` on mobile; on PC the inset when it is wider than the 32 px, for a
 * phone in landscape that is wide enough for the PC layout).
 */
export const SHELL_EDGE =
  'safe-x desk:pl-[max(32px,var(--safe-left),calc((100%_-_1376px)/2_+_32px))] desk:pr-[max(32px,var(--safe-right),calc((100%_-_1376px)/2_+_32px))]';
