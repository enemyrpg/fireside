import { Writable } from 'node:stream';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { AuthLimiters } from '../auth/login-limiter.js';
import { memoryKeyStore, type KeyStore } from '../auth/secret-box.js';
import { createSession } from '../auth/sessions.js';
import type { Database } from '../db/index.js';
import { testConfig } from '../test-utils.js';
import { createPasswordHasher, type PasswordHasher } from './password.js';
import { createUser, FIRST_USER_ID, setPasswordHash, type UserRole } from './users.js';

// Helpers for the tests of invites, users and deletion: an app in login mode
// with a cheap hasher, a controllable clock and captured logs.

export const HOST = 'localhost:3100';
export const ORIGIN = `http://${HOST}`;
export const PASSWORD = 'correct horse battery';
export const START = Date.parse('2026-11-18T12:00:00.000Z');
const CHEAP = { memory: 64, passes: 1, parallelism: 1 };

export type Method = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE';

export interface LoginApp {
  app: FastifyInstance;
  hasher: PasswordHasher;
  /** Every log line, at trace level. */
  logs: string[];
  clock: { now: number };
  /** Every auth bucket, shared by the auth and invite routes. */
  limiters: AuthLimiters;
  /** The 2FA key, in memory. */
  keyStore: KeyStore & { key: Buffer | undefined };
  /** Sends a request as `token`'s user (or without a session). */
  send: (
    method: Method,
    url: string,
    options?: {
      token?: string | undefined;
      payload?: unknown;
      headers?: Record<string, string>;
      /** More cookies (name → value), e.g. the device or 2FA cookie. */
      cookies?: Record<string, string>;
      /** The socket address. Default: 127.0.0.1. */
      remoteAddress?: string;
    },
  ) => Promise<LightMyRequestResponse>;
  /** Gives `userId` a password (login mode on) and a session; returns its token. */
  logIn: (userId: number) => Promise<string>;
  /** Adds a user with a password and a session. */
  addUser: (username: string, role?: UserRole) => Promise<{ id: number; token: string }>;
}

export interface LoginAppOptions {
  env?: Record<string, string>;
  /** Wraps the hasher, e.g. to slow down `hash`. */
  wrapHasher?: (hasher: PasswordHasher) => PasswordHasher;
  generateId?: () => string;
  /** A built dashboard folder to serve, as in production. */
  webDir?: string;
}

/** An app on `database`, with user 1 (admin) given a password, so login mode is on. */
export async function loginApp(
  database: Database,
  { env = {}, wrapHasher = (hasher) => hasher, generateId, webDir }: LoginAppOptions = {},
): Promise<LoginApp & { adminToken: string }> {
  const clock = { now: START };
  const now = () => new Date(clock.now);
  const hasher = wrapHasher(createPasswordHasher({ params: CHEAP }));
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  });
  const limiters = new AuthLimiters({ now });
  const keyStore = memoryKeyStore();
  const app = buildApp({
    db: database,
    config: testConfig({ LOG_LEVEL: 'trace', ...env }),
    logStream,
    ...(webDir === undefined ? {} : { webDir }),
    dashboard: {
      now,
      auth: { hasher, limiters },
      keyStore,
      invites: generateId ? { generateId } : {},
    },
  });

  const logIn = async (userId: number) => {
    setPasswordHash(database.db, userId, await hasher.hash(PASSWORD));
    return createSession(database.db, userId, { now: now() }).token;
  };
  const send: LoginApp['send'] = (
    method,
    url,
    { token, payload, headers = {}, remoteAddress, cookies = {} } = {},
  ) => {
    const jar = {
      ...(token === undefined ? {} : { [SESSION_COOKIE]: token }),
      ...cookies,
    };
    const cookie = Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const options: InjectOptions = {
      method,
      url,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
      headers: {
        host: HOST,
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
        ...(cookie === '' ? {} : { cookie }),
        ...headers,
      },
      ...(payload === undefined
        ? {}
        : { payload: payload as NonNullable<InjectOptions['payload']> }),
    };
    return app.inject(options);
  };
  const addUser: LoginApp['addUser'] = async (username, role = 'member') => {
    const id = createUser(database.db, username, { role, now: now() });
    return { id, token: await logIn(id) };
  };
  const adminToken = await logIn(FIRST_USER_ID);
  return { app, hasher, logs, clock, limiters, keyStore, send, logIn, addUser, adminToken };
}

/** Every `Set-Cookie` of a response, by cookie name (value only; `''` when cleared). */
export function setCookies(response: LightMyRequestResponse): Map<string, string> {
  const header = response.headers['set-cookie'];
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  return new Map(
    list.map((line) => {
      const pair = line.split(';')[0] ?? '';
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)] as const;
    }),
  );
}

/** The session token a response set, if any. */
export function cookieToken(response: LightMyRequestResponse): string | undefined {
  const value = setCookies(response).get(SESSION_COOKIE);
  return value === '' ? undefined : value;
}

/** The token in an invite or reset link's fragment. */
export function tokenOf(url: string): string {
  const token = new URL(url).hash.slice(1);
  if (token === '') throw new Error(`No token in ${url}`);
  return token;
}
