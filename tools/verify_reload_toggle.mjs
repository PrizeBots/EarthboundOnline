// Verifies the editor Reload toggle actually gates SOURCE (.ts) hot-reload.
// For each toggle state: connect to Vite's HMR ws, edit a real source module,
// and observe whether a `full-reload` arrives — then confirm the freshly
// transformed module is served either way (so a manual refresh always works).
import WebSocket from 'ws';
import fs from 'fs';

const BASE = 'http://localhost:4444';
const WS = 'ws://localhost:4444';
const FILE = 'src/main.ts';
const original = fs.readFileSync(FILE, 'utf8');
// A SIDE-EFFECTING statement (not a comment — esbuild strips comments during the
// dev transform, so a comment probe would never appear in the served module).
const marker = `globalThis.__reloadProbe = 'reload-toggle-probe-${Date.now()}';`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setToggle = (on) =>
  fetch(`${BASE}/__editor/hotreload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
  }).then((r) => r.json());

async function trial(on) {
  await setToggle(on);
  const ws = new WebSocket(WS, 'vite-hmr');
  let fullReload = false;
  ws.on('message', (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === 'full-reload' || (m.type === 'update' && m.updates?.length)) fullReload = true;
    } catch {
      /* ignore non-JSON */
    }
  });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  await sleep(300);

  // Edit the source file (append a unique comment), then wait for HMR to settle.
  fs.writeFileSync(FILE, original + '\n' + marker + (on ? '-on' : '-off') + '\n');
  await sleep(1500);

  // Was the freshly transformed module served? (manual-refresh freshness)
  const served = await fetch(`${BASE}/${FILE}`, { cache: 'no-store' }).then((r) => r.text());
  const fresh = served.includes('reload-toggle-probe');

  ws.close();
  fs.writeFileSync(FILE, original); // revert
  await sleep(800); // let the revert settle before the next trial
  return { fullReload, fresh };
}

try {
  const off = await trial(false);
  const onState = await trial(true);
  console.log('OFF  → fullReload:', off.fullReload, ' servedFresh:', off.fresh);
  console.log('ON   → fullReload:', onState.fullReload, ' servedFresh:', onState.fresh);
  const pass = off.fullReload === false && off.fresh === true && onState.fullReload === true;
  console.log(pass ? 'PASS ✅' : 'FAIL ❌');
  process.exit(pass ? 0 : 1);
} finally {
  fs.writeFileSync(FILE, original); // belt-and-suspenders revert
  await setToggle(false); // leave it OFF (the user's working state)
}
