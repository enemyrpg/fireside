#!/usr/bin/env node
// Launcher for `pnpm seed` (see launch.js).
import { launch } from './launch.js';

await launch('seed/index');
