#!/usr/bin/env node
// Cross-platform boardroom entry (Mac/Linux/Windows). No bash, no tmux.
import('../dist/boardroom/boardroom.js').catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
