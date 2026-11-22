import { describe, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import {
  loginResponseSchema,
  loginTotpRequestSchema,
  recoveryCodesResponseSchema,
  totpConfirmRequestSchema,
  totpSetupResponseSchema,
  twoFactorStatusResponseSchema,
} from './auth.js';
import { passwordResetRequestSchema } from './invites.js';

// Two-factor authentication (contract 1.35.0).

const user = {
  id: 1,
  username: 'admin',
  role: 'admin',
  canCreateApiKeys: true,
  twoFactorEnabled: true,
};

describe('POST /auth/login response', () => {
  const response = schemaAsserts(loginResponseSchema);

  it('is either the user or a 2FA step, never both', () => {
    response.accepts({ user });
    response.accepts({ twoFactorRequired: true });
    response.rejects({ twoFactorRequired: false });
    response.rejects({ twoFactorRequired: true, user });
    response.rejects({});
  });
});

describe('codes', () => {
  it('takes a code as a bounded string', () => {
    const request = schemaAsserts(loginTotpRequestSchema);
    request.accepts({ code: '123456' });
    request.accepts({ code: 'abcde-fgh23' });
    request.rejects({ code: 123456 });
    request.rejects({ code: 'x'.repeat(65) });
  });

  it('needs password and code to turn 2FA off or make new recovery codes', () => {
    const request = schemaAsserts(totpConfirmRequestSchema);
    request.accepts({ password: 'correct horse battery', code: '123456' });
    request.rejects({ password: 'correct horse battery' });
    request.rejects({ code: '123456' });
  });

  it('takes an optional code on a reset link', () => {
    const request = schemaAsserts(passwordResetRequestSchema);
    request.accepts({ token: 'abc', password: 'correct horse battery' });
    request.accepts({ token: 'abc', password: 'correct horse battery', code: '123456' });
  });
});

describe('2FA status and setup', () => {
  it('never shows a secret in the status', () => {
    const status = schemaAsserts(twoFactorStatusResponseSchema);
    status.accepts({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
    status.rejects({ enabled: true, enabledAt: null, recoveryCodesLeft: 1, secret: 'ABC' });
  });

  it('gives a base32 secret and an otpauth URI', () => {
    const setup = schemaAsserts(totpSetupResponseSchema);
    setup.accepts({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/F:a?secret=X' });
    setup.rejects({ secret: 'JBSWY3DPEHPK3PX1', otpauthUri: 'otpauth://totp/F:a' });
    setup.rejects({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://hotp/F:a' });
  });

  it('gives exactly ten recovery codes', () => {
    const codes = schemaAsserts(recoveryCodesResponseSchema);
    const ten = Array.from({ length: 10 }, () => 'abcde-fgh23');
    codes.accepts({ recoveryCodes: ten });
    codes.rejects({ recoveryCodes: ten.slice(1) });
    codes.rejects({ recoveryCodes: [...ten.slice(1), 'ABCDE-FGH23'] });
  });
});
