import type { AboutResponse } from '@fireside/shared';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';

// The instance text: who runs the server and what it stores. Public: `/about`
// reads it before anyone logs in.

export const ABOUT_KEY = ['about'] as const;

/** `GET /about`. */
export function useAbout() {
  return useQuery({
    queryKey: ABOUT_KEY,
    queryFn: ({ signal }) => apiGet<AboutResponse>('about-response', '/about', { signal }),
    staleTime: 5 * 60_000,
  });
}
