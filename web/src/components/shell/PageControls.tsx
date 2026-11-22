import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PageControlsContext } from './page-controls-context';

/** Renders `children` in the top bar's controls slot (a row under the title on mobile). */
export function PageControls({ children }: { children: ReactNode }) {
  const target = useContext(PageControlsContext);
  return target ? createPortal(children, target) : null;
}
