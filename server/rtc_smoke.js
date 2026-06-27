'use strict';
/**
 * WebRTC DataChannel smoke test (Stage D). Boots a REAL GameHost with RTC_ENABLED,
 * connects one WS client that ALSO plays the browser's WebRTC role via
 * node-datachannel — offers an unreliable 'firehose' DataChannel exactly like
 * Network.ts setupRtc() — and verifies the whole path end-to-end WITHOUT a browser:
 *
 *   offer/answer + ICE over the WS  →  DataChannel opens  →  binary firehose
 *   (npc_update / player_move) actually arrives over the DataChannel.
 *
 *   node server/rtc_smoke.js
 *
 * PASS = the channel opened and ≥1 binary frame rode it. The browser client speaks
 * the identical protocol, so a green run means `?rtc` + RTC_ENABLED=1 is live.
 */
process.env.RTC_ENABLED = '1';
process.env.AOI_ENABLED = '1';
process.env.BINARY_WIRE = '1';

const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { GameHost } = require('./gameHost');
const rtc = require('./rtc');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const RUN_MS = 9000;

async function main() {
  if (!rtc.rtcAvailable()) {
    console.error('FAIL: node-datachannel did not load — WebRTC transport unavailable.');
    process.exit(1);
  }
  const ndc = require('node-datachannel');

  const host = new GameHost(ASSETS);
  host.start();
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => host.handleConnection(ws));
  await new Promise((r) => wss.on('listening', r));
  const url = `ws://localhost:${wss.address().port}/ws`;

  const ws = new WebSocket(url);
  let pc = null;
  let dc = null;
  let dcOpen = false;
  let rtcFrames = 0;
  let rtcBytes = 0;
  let remoteSet = false;
  const pendingIce = [];

  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

  ws.on('open', () => send({ type: 'join', name: 'RTCsmoke', spriteGroupId: 1 }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // firehose over WS — irrelevant to this test
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.type === 'welcome') {
      startRtc();
    } else if (m.type === 'rtc_answer' && m.sdp) {
      pc.setRemoteDescription(m.sdp, 'answer');
      remoteSet = true;
      for (const c of pendingIce.splice(0)) pc.addRemoteCandidate(c.cand, c.mid || '0');
    } else if (m.type === 'rtc_ice' && typeof m.cand === 'string') {
      if (remoteSet) pc.addRemoteCandidate(m.cand, m.mid || '0');
      else pendingIce.push({ cand: m.cand, mid: m.mid });
    }
  });

  function startRtc() {
    pc = new ndc.PeerConnection('rtc-smoke', { iceServers: ['stun:stun.l.google.com:19302'] });
    // Creating the data channel triggers the local OFFER (onLocalDescription).
    pc.onLocalDescription((sdp, type) => {
      if (type === 'offer') send({ type: 'rtc_offer', sdp });
    });
    pc.onLocalCandidate((cand, mid) => send({ type: 'rtc_ice', cand, mid }));
    dc = pc.createDataChannel('firehose', { ordered: false, maxRetransmits: 0 });
    dc.onOpen(() => {
      dcOpen = true;
      console.log('[rtc-smoke] DataChannel OPEN — firehose now on WebRTC');
    });
    dc.onMessage((msg) => {
      rtcFrames++;
      rtcBytes += msg.length || msg.byteLength || 0;
    });

    // Keep the player moving so the firehose stays hot (nearby NPCs also feed it).
    let seq = 1;
    const drive = setInterval(() => {
      if (ws.readyState !== 1) return;
      const dx = seq % 2 ? 1 : -1;
      send({ type: 'input', seq: seq++, dx, dy: 0 });
    }, 33);
    setTimeout(() => clearInterval(drive), RUN_MS - 500);
  }

  await new Promise((r) => setTimeout(r, RUN_MS));

  const ok = dcOpen && rtcFrames > 0;
  console.log('\n=== WebRTC smoke ===');
  console.log(`  node-datachannel : loaded`);
  console.log(`  DataChannel open : ${dcOpen}`);
  console.log(`  firehose frames  : ${rtcFrames}  (${rtcBytes} bytes) over the DataChannel`);
  console.log(
    `\n  ${ok ? 'PASS' : 'FAIL'}: ${ok ? 'WebRTC firehose verified end-to-end' : 'channel never carried the firehose'}`
  );

  try {
    dc && dc.close();
    pc && pc.close();
    ws.close();
    ndc.cleanup();
  } catch {
    /* teardown best-effort */
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
