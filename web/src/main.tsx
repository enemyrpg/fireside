import '@/index.css';
import { BRANDING } from '@fireside/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { createQueryClient } from '@/api/query-client';
import { App } from '@/App';
import { syncFavicon } from '@/branding/favicon';
import { syncThemeColor } from '@/branding/theme-color';
import { watchVisualViewport } from '@/lib/visual-viewport';
import { createRoutes } from '@/routing/routes';

document.title = BRANDING.displayName;
syncFavicon();
syncThemeColor();
watchVisualViewport();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(
  <StrictMode>
    <App queryClient={createQueryClient()} router={createBrowserRouter(createRoutes())} />
  </StrictMode>,
);
