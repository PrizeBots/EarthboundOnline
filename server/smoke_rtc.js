'use strict';
/**
 * Headless smoke for the WebRTC server transport (server/rtc.js). The browser
 * client uses native RTCPeerConnection which we can't drive in CI, but
 * node-datachannel can act as BOTH ends — so we stand up a node "client" peer,
 * relay signaling straight between it and our server peer (no WS), and assert the
 * unreliable DataChannel opens and carries a binary firehose frame end-to-end.
 *
 * Validates: createServerPeer lifecycle, the offer/answer + ICE relay shape, and
 * that sendBin's `_rtc.send(buf)` actually delivers bytes. Run: node server/smoke_rtc.js
 */
const ndc = require('node-datachannel');
const { createServerPeer, rtcAvailable } = require('./rtc');

if (!rtcAvailable()) {
  console.error('SMOKE FAIL — node-datachannel not available');
  process.exit(1);
}

const PAYLOAD = Buffer.from([0x01, 0x02, 0x00, 0x05, 0x00, 0xde, 0xad, 0xbe, 0xef]);
let done = false;
const finish = (ok, why) => {
  if (done) return;
  done = true;
  console.log(ok ? `SMOKE PASS — ${why}` : `SMOKE FAIL — ${why}`);
  try {
    server.close();
    client.close();
  } catch {
    /* ignore */
  }
  process.exit(ok ? 0 : 1);
};

// Server half (the unit under test). Signaling is relayed directly to the client.
const server = createServerPeer(
  'smoke',
  (sig) => {
    if (sig.type === 'rtc_answer') client.setRemoteDescription(sig.sdp, sig.sdpType || 'answer');
    else if (sig.type === 'rtc_ice') client.addRemoteCandidate(sig.cand, sig.mid || '0');
  },
  {
    onOpen: (ch) => {
      console.log('  ok   server sees DataChannel open');
      ch.send(PAYLOAD); // exactly what gameHost.sendBin → _rtc.send does
    },
    onClose: () => {},
  }
);

// Node "client" peer — stands in for the browser. It offers the channel.
const client = new ndc.PeerConnection('smoke-client', {
  iceServers: ['stun:stun.l.google.com:19302'],
});
client.onLocalDescription((sdp, type) => {
  if (type === 'offer') server.onOffer(sdp);
});
client.onLocalCandidate((cand, mid) => server.onCandidate(cand, mid));

const dc = client.createDataChannel('firehose');
dc.onOpen(() => console.log('  ok   client channel open'));
dc.onMessage((m) => {
  const buf = Buffer.isBuffer(m) ? m : Buffer.from(m);
  const ok = buf.equals(PAYLOAD);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} client received the firehose frame intact (${buf.length}B)`
  );
  finish(ok, ok ? '3/3 checks' : 'payload mismatch');
});

setTimeout(() => finish(false, 'timed out before the DataChannel delivered (no UDP path?)'), 10000);
