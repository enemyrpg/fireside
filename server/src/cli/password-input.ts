// Reads passwords for `pnpm cli users …`. At a terminal, without echo; from
// a pipe or file, one line per password (for scripts and
// `docker compose exec -T`). Never from the command line.

/** Lines from a non-terminal stdin, read once and handed out in order. */
let pipedLines: Promise<string[]> | undefined;

function readAllStdin(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8').split(/\r?\n/));
    });
    process.stdin.on('error', reject);
  });
}

function readHidden(prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (result: string | undefined) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      resolve(result);
    };
    const onData = (text: string) => {
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          finish(value);
          return;
        }
        if (char === '\u0003') {
          // Ctrl-C: stop without changing anything.
          finish(undefined);
          process.exit(130);
        }
        if (char === '\u0004') {
          finish(value === '' ? undefined : value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (char >= ' ') {
          value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}

export const stdinIsTerminal = (): boolean => process.stdin.isTTY;

/** Reads one password. `undefined` when input ended. */
export async function readPassword(prompt: string): Promise<string | undefined> {
  if (stdinIsTerminal()) return readHidden(prompt);
  pipedLines ??= readAllStdin();
  const lines = await pipedLines;
  return lines.shift();
}
