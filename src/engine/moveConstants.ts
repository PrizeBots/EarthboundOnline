// The client↔server MIRRORED movement/stamina constants — the single client
// copy (Player.ts + StatusModal.ts import from here). The server copy lives in
// server/gameHost.js (exported as MIRRORED_CONSTANTS), and
// test/constantsSync.test.ts asserts the two sides are equal, so a change to
// one side without the other fails CI instead of drifting silently.
export const SPEED_BASE = 0.8; // px/frame floor contribution
export const SPEED_PER_STAT = 0.085; // px/frame added per point of the Speed stat
export const SPEED_MIN = 0.75; // never slower than this (a crawl isn't fun)
export const SPEED_MAX = 2.6; // never faster than this (camera/collision stay sane)
export const RUN_MULT = 1.4; // run speed = walk speed * this (while you can run)
export const RUN_DRAIN_PER_SEC = 24; // stamina burned per second of running (server applies /60 per step)
export const STAMINA_ATTACK_COST = 8; // stamina per swing (not enough = can't attack)
export const RUN_RECOVER_FRAC = 0.2; // winded → can run again once recharged to this fraction

// Player collision box (relative to position, which is center-bottom of sprite)
export const PLAYER_COL_W = 14;
export const PLAYER_COL_H = 8;
export const PLAYER_COL_OY = -8; // collision box is near feet
