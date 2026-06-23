'use strict';
/**
 * WebRTC DataChannel transport for the position firehose (netcode Stage D).
 *
 * WHY: the firehose rides a WebSocket (TCP) today. On a lossy/jittery link TCP
 * retransmits and HEAD-OF-LINE BLOCKS the whole stream until the lost segment
 * recovers — that's the freeze the client coasts over. An unordered/unreliable
 * DataChannel turns a lost packet into ONE skipped snapshot (the delta/seq path
 * already tolerates gaps), never a stream-wide stall. A real LAN never HoL-blocks;
 * this is the change that makes a WAN link behave like one for movement.
 *
 * SCOPE: WebSocket stays the signaling + reliable-control + FALLBACK channel. This
 * module only owns one peer's unreliable DataChannel. The CLIENT is the offerer and
 * creates the channel; the server answers and receives it via onDataChannel.
 *
 * Opt-in: gated by RTC_ENABLED in gameHost (server) + `?rtc` (client). Off by
 * default — until verified live, the WS path is unchanged.
 *
 * node-datachannel is a native addon (prebuilt binaries). If it can't load, this
 * module degrades to a no-op factory so the server still runs on pure WebSocket.
 */

let ndc = null;
try {
  ndc = require('node-datachannel');
} catch (e) {
  console.warn('[rtc] node-datachannel unavailable — WebRTC transport disabled:', e.message);
}

const ICE_SERVERS = ['stun:stun.l.google.com:19302'];

/** True when the native lib loaded and RTC peers can be created. */
function rtcAvailable() {
  return !!ndc;
}

/**
 * Create the server half of a peer for one client. `signal(msg)` ships a signaling
 * JSON back over that client's WebSocket. Callbacks report the live channel:
 *   onOpen(channel)  — DataChannel is open; `channel.sendBinary(buf)` now works
 *   onClose()        — channel/peer gone; caller must fall back to WS
 *
 * Returns a handle: { onOffer(sdp), onCandidate(cand, mid), send(buf), isOpen(), close() }.
 * No-op handle when the native lib is missing.
 */
function createServerPeer(id, signal, { onOpen, onClose } = {}) {
  if (!ndc) {
    return { onOffer() {}, onCandidate() {}, send() {}, isOpen: () => false, close() {} };
  }

  const pc = new ndc.PeerConnection(`peer-${id}`, { iceServers: ICE_SERVERS });
  let dc = null;
  let closed = false;

  pc.onLocalDescription((sdp, type) => signal({ type: 'rtc_answer', sdp, sdpType: type }));
  pc.onLocalCandidate((cand, mid) => signal({ type: 'rtc_ice', cand, mid }));

  pc.onDataChannel((channel) => {
    dc = channel;
    dc.onOpen(() => onOpen && onOpen(handle));
    dc.onClosed(() => {
      dc = null;
      if (!closed && onClose) onClose();
    });
    // The server never expects inbound DataChannel traffic today (client→server
    // stays on the reliable WS), but draining keeps the channel healthy.
    dc.onMessage(() => {});
  });

  const handle = {
    /** Client SDP offer arrived over WS → set it and let onLocalDescription answer. */
    onOffer(sdp) {
      try {
        pc.setRemoteDescription(sdp, 'offer');
      } catch (e) {
        console.warn(`[rtc] ${id} setRemoteDescription failed:`, e.message);
      }
    },
    /** A trickled ICE candidate from the client. */
    onCandidate(cand, mid) {
      try {
        pc.addRemoteCandidate(cand, mid || '0');
      } catch (e) {
        /* late/duplicate candidate — ignore */
      }
    },
    /** Send a binary firehose frame over the unreliable channel. */
    send(buf) {
      if (dc) dc.sendMessageBinary(buf);
    },
    isOpen() {
      return !!dc && dc.isOpen();
    },
    close() {
      closed = true;
      try {
        if (dc) dc.close();
        pc.close();
      } catch {
        /* already torn down */
      }
    },
  };
  return handle;
}

module.exports = { createServerPeer, rtcAvailable };
