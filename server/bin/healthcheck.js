#!/usr/bin/env node
// Docker HEALTHCHECK: exits 0 if `GET /api/v1/health` answers 200 on this
// machine's loopback, otherwise 1. The slim image has no curl. Health is
// outside the local-only dashboard scope and tells nothing about the data.
// Empty counts as unset, as in server/src/config.ts.
const configuredPort = process.env.PORT?.trim();
const port = configuredPort === undefined || configuredPort === '' ? '3100' : configuredPort;

try {
  // eslint-disable-next-line no-restricted-globals -- this machine's loopback only, never an external call
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    console.error(`Health check failed: HTTP ${String(response.status)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`Health check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
