// Preloaded (`node --import`) into every scratch server and seed run that the
// scripts start (scratch-server.ts). The server loads the repo's `.env` with
// `process.loadEnvFile`; here that does nothing, so a scratch server only ever
// sees the environment it was given and can never pick up a developer's
// PRICES_ENABLED, RUNEPROFILE_ENABLED, USER_AGENT_CONTACT, DATA_DIR or PORT.
process.loadEnvFile = () => {
  // Nothing: the environment a scratch server was given is all it gets.
};
