#!/usr/bin/env node
// boardroom entry. Live claude per thinker, carried by tmux (Mac/Linux; Windows via WSL).
import('../dist/boardroom/boardroom.js').catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
