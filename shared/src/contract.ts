/**
 * Version of the contract between plugin and server (events and API).
 *
 * Semver: bump the minor version for additions (new event types, new fields),
 * the major version for breaking changes. Payloads are strict, so a new field
 * is only accepted by servers on the new version. The server reports this
 * version in `GET /ingest/verify`, and the contract package is tagged with it.
 */
export const CONTRACT_VERSION = '1.42.0';

/** Value of `schemaVersion` in every event. Changes only on breaking event changes. */
export const EVENT_SCHEMA_VERSION = 1;
