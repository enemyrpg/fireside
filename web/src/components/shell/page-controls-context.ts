import { createContext } from 'react';

// Lets a page put its own controls (period toggle, week navigation) in the
// top bar, which the shell owns. Holds the slot element.
export const PageControlsContext = createContext<HTMLElement | null>(null);
