#!/usr/bin/env node
// MCP stdio server entry. Point any MCP-capable agent at this binary to get
// native chat tools (join/send/poll/roster) backed by the same local broker.
import('../dist/mcp/server.js').catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
