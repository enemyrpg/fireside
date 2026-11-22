import { defineConfig } from 'drizzle-kit';

// Only used by drizzle-kit to generate and check migrations. The server
// runs the generated migrations itself at startup (src/db/index.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
