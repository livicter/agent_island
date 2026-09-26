/* index.js — Agent Island multiplayer server entry point.
 *
 * Creates the authoritative engine, starts the HTTP+WS network layer,
 * and advances the simulation on a fixed 50 ms timestep.
 */
'use strict';

const { Engine } = require('./engine');
const { start } = require('./net');

const PORT = Number(process.env.PORT || 8902);

const engine = new Engine();

// Persistence: restore the last snapshot if one exists; otherwise boot fresh.
if (engine.loadFromDisk()) {
  const c = engine.clockState();
  console.log(`[server] restored snapshot — ${engine.order.length} residents, day ${c.day}, ${c.time}`);
} else {
  engine.spawnRoster();
  console.log('[server] fresh boot — spawned roster');
}

const net = start(engine, { port: PORT });

// Fixed-step simulation: 50 ms -> tick(0.05).
const simTimer = setInterval(() => {
  try {
    engine.tick(0.05);
  } catch (e) {
    console.error('[engine] tick error:', e.message);
  }
}, 50);

console.log(`island engine on :${net.port} — ${engine.order.length} residents`);

// Autosave the world every 30 s (unref'd so it never blocks shutdown).
const saveTimer = setInterval(() => {
  try {
    engine.saveToDisk();
  } catch (e) {
    console.error('[persist] autosave failed:', e.message);
  }
}, 30000);
saveTimer.unref();

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down...`);
  clearInterval(simTimer);
  clearInterval(saveTimer);
  try {
    engine.saveToDisk();
    console.log('[server] snapshot saved');
  } catch (e) {
    console.error('[persist] shutdown save failed:', e.message);
  }
  net.close(() => {
    console.log('[server] closed');
    process.exit(0);
  });
  // hard stop if sockets hang
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
