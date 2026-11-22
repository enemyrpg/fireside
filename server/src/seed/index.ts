import { ConfigError, loadConfig, loadEnvFile, type Config } from '../config.js';
import { runSeed } from './run.js';

// Entry point for `pnpm seed`. Reads TZ (and the normal DATA_DIR, which it
// refuses to touch) from the same `.env` as the server.

loadEnvFile();

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}
process.env.TZ = config.timeZone;

process.exitCode = await runSeed(process.argv.slice(2), {
  config,
  now: () => new Date(),
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
});
