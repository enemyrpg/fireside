import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type DataRouter } from 'react-router';
import { useRefetchWhenServerBack } from '@/api/query-client';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthGate } from '@/routing/AuthGate';

export interface AppProps {
  queryClient: QueryClient;
  router: DataRouter;
}

export function App({ queryClient, router }: AppProps) {
  useRefetchWhenServerBack(queryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
        <Toaster position="top-center" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
