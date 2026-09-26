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
engine.spawnRoster();

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

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down...`);
  clearInterval(simTimer);
  net.close(() => {
    console.log('[server] closed');
    process.exit(0);
  });
  // hard stop if sockets hang
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
