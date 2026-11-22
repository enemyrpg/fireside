import { describe, expect, it } from 'vitest';
import { LOGIN_TIMED_OUT } from '@/api/auth';
import { ApiError, NetworkError } from '@/api/errors';
import { codeFieldRejected, loginCodeRejected } from './code-errors';

describe('code errors', () => {
  it('counts only a wrong login code as rejected', () => {
    expect(loginCodeRejected(new ApiError(401, 'UNAUTHORIZED', 'Invalid code'))).toBe(true);
    expect(loginCodeRejected(new ApiError(401, 'UNAUTHORIZED', LOGIN_TIMED_OUT))).toBe(false);
    expect(loginCodeRejected(new ApiError(429, 'RATE_LIMITED', 'Wait'))).toBe(false);
    expect(loginCodeRejected(new ApiError(503, 'RATE_LIMITED', 'Wait'))).toBe(false);
    expect(loginCodeRejected(new NetworkError('down'))).toBe(false);
  });

  it('counts a field error on the code as rejected, and nothing else', () => {
    const wrongCode = new ApiError(400, 'VALIDATION_ERROR', 'Invalid', [
      { path: 'body.code', message: 'Wrong code' },
    ]);
    const wrongPassword = new ApiError(400, 'VALIDATION_ERROR', 'Invalid', [
      { path: 'body.password', message: 'Wrong password' },
    ]);
    expect(codeFieldRejected(wrongCode)).toBe(true);
    expect(codeFieldRejected(wrongPassword)).toBe(false);
    expect(codeFieldRejected(new ApiError(429, 'RATE_LIMITED', 'Wait'))).toBe(false);
    expect(codeFieldRejected(new NetworkError('down'))).toBe(false);
  });
});
