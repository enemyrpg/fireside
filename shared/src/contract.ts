/**
 * Version of the contract between plugin and server (events and API).
 *
 * Semver (major, minor and patch rules in docs/decisions/0007-contract-package.md).
 * The server reports it in `GET /health` and `GET /ingest/verify`, and the
 * contract package is tagged with it.
 */
export const CONTRACT_VERSION = '1.42.1';

/** Value of `schemaVersion` in every event. Changes only on breaking event changes. */
export const EVENT_SCHEMA_VERSION = 1;
