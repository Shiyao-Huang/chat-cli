#!/usr/bin/env node
// Universal entry: the "pager + talk-port" for any shell-capable runtime.
// Resolves the compiled CLI relative to this file's URL (works after `npm run build`).
import('../dist/cli.js').catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
