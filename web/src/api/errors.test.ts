import { describe, expect, it } from 'vitest';
import { codeErrorMessage, loginErrorMessage } from './auth';
import { ApiError, isAskedToWait, isServerDown } from './errors';
import { formErrorMessage } from './users';

const BUSY = 'The server is busy. Try again in a few seconds.';

describe('isAskedToWait', () => {
  it('is true for a 429 and for the server’s own 503', () => {
    expect(isAskedToWait(new ApiError(429, 'RATE_LIMITED', 'Too many login attempts.'))).toBe(true);
    expect(isAskedToWait(new ApiError(503, 'RATE_LIMITED', BUSY))).toBe(true);
  });

  it('is false for a 503 from a proxy, which means the server is down', () => {
    const gateway = new ApiError(503, 'UNKNOWN', 'Service Unavailable');
    expect(isAskedToWait(gateway)).toBe(false);
    expect(isServerDown(gateway)).toBe(true);
    expect(isServerDown(new ApiError(503, 'RATE_LIMITED', BUSY))).toBe(false);
  });

  it('shows the server’s message on the login, code and settings forms', () => {
    const busy = new ApiError(503, 'RATE_LIMITED', BUSY);
    expect(loginErrorMessage(busy)).toBe(BUSY);
    expect(codeErrorMessage(busy)).toBe(BUSY);
    expect(formErrorMessage(busy, 'fallback')).toBe(BUSY);
  });
});
