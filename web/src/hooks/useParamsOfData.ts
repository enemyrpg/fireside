import { useState } from 'react';

/**
 * The parameters the data on screen was loaded with. While new parameters
 * load, a query keeps showing the previous data (`isPlaceholderData`), so
 * labels must follow that data, not the URL. Returns `params` once the data for
 * them has arrived, and until then the parameters of the last data that wasn't
 * a placeholder.
 *
 * Unlike reading the range back from the response, this stays right when the
 * query key changes for another reason, e.g. a new local day.
 */
export function useParamsOfData<P>(
  query: { data: unknown; isPlaceholderData: boolean },
  params: P,
): P {
  const [settled, setSettled] = useState<{ data: unknown; params: P }>();
  const { data, isPlaceholderData } = query;
  // Storing information from earlier renders: React re-renders at once with the new state.
  if (data !== undefined && !isPlaceholderData && settled?.data !== data) {
    setSettled({ data, params });
  }
  return isPlaceholderData && settled ? settled.params : params;
}
