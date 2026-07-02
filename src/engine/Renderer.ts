import { Camera } from './Camera';
import { Player } from './Player';
import { NPC } from './NPC';
import { getTileAt, getSectorForTile, getOverworldHeightTiles } from './MapManager';
import { colBoxFor, carColBoxFor, hasEntityCol } from './NPCManager';
import { drawTile, drawForegroundTile, hasForegroundTile } from './TilesetManager';
import { isComposite, drawComposite, drawCompositeFg } from './CompositeTiles';
import { drawSprite, getSpriteGroupMeta, SpritePart } from './SpriteManager';
import { getNameplate, getLevelPlate } from './NamePlate';
import { drawHeldItem, isItemBehind } from './Items';
import { renderDrops } from './DropManager';
import { collectProjectileSprites, ProjectileSprite } from './Projectiles';
import { collectDeathSprites, DeathSprite } from './DeathFx';
import { isTouchDevice } from './TouchControls';
import {
  getSpritePriority,
  getPromotedMinitiles,
  getBackgroundMinitiles,
  getEffectiveRowAt,
  FG_PROMOTE_BIT,
  FORCE_BG_BIT,
} from './Collision';
import { DIR_VEC as DBG_DIR_VEC } from './directions';
import { syncMuteButtonPosition } from './MuteButton';
import { getStatus } from './StatusModal';
import { rollHealth, pendFlash, HpHolder } from './HealthRoll';
import { drawText, measureText, getLineHeight } from './TextRenderer';
import {
  Pose,
  Direction,
  RemotePlayer,
  KoThrowState,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  TILE_SIZE,
  MINITILE_SIZE,
  MAP_WIDTH_TILES,
} from '../types';

// --- Debug hit/hurt boxes (toggle with B) --------------------------------
// Geometry mirrors server/npcSim.js so what's drawn matches what the server
// resolves. Hurtbox = the body box an attack must overlap; the attack hitbox
// is shown in front of the player while a swing plays.
let debugBoxes = false;
export function setDebugBoxes(on: boolean): void {
  debugBoxes = on;
}
export function debugBoxesOn(): boolean {
  return debugBoxes;
}

// --- Debug collision/priority layers (editor header "Collision" toggle) ----
// Tints the live world with the SAME overlay the Collision & Priority Painter
// draws (reads getEffectiveRowAt, so it shows exactly what the collision system
// resolves): red = solid wall (0x80), blue = pri-lo (0x01), purple = pri-hi
// (0x02), yellow = FG-promote/hide (0x40). Off by default.
let debugCollision = false;
export function setDebugCollision(on: boolean): void {
  debugCollision = on;
}
export function debugCollisionOn(): boolean {
  return debugCollision;
}

// --- Per-layer visibility (editor header "BG"/"FG"/"Sprites" toggles) -------
// Hide a render layer to inspect what lives on each one while authoring. All on
// by default; only the editor flips them. When FG is hidden the per-sprite FG
// re-cover is skipped too, so sprites aren't occluded by an invisible layer.
let showBg = true;
let showFg = true;
let showSprites = true;
export function setLayerVisible(layer: 'bg' | 'fg' | 'sprites', on: boolean): void {
  if (layer === 'bg') showBg = on;
  else if (layer === 'fg') showFg = on;
  else showSprites = on;
}
export function layerVisible(layer: 'bg' | 'fg' | 'sprites'): boolean {
  return layer === 'bg' ? showBg : layer === 'fg' ? showFg : showSprites;
}

// Below this editor zoom the world is so shrunk that foreground tiles (canopies,
// sign tops) are a pixel or two — invisible. Skip the two FG tile passes there
// to cut the per-frame drawImage count by ~2/3, keeping far-out panning smooth.
// Gameplay (zoom 1) and normal editor zoom are unaffected.
const FG_PASS_MIN_ZOOM = 0.18;

const HURT_W = 14;
const HURT_H = 18;
const HURT_OY = -18;
const ATTACK_REACH = 14;
const ATTACK_HALF = 8;

// --- Health / PSI bars ------------------------------------------------------
// Drawn above an entity's head, half-pixel black outline (crisp at the gameplay
// supersample). HP fill: green at full, blending to yellow at 50%, red at 30%-.
// The LOCAL player's bar also carries a PSI (PP) bar stacked directly beneath
// the HP bar — sharing the middle divider line to stay compact — dark blue at
// full PP fading to light blue when low.
// Visibility: you ONLY see your OWN player bar; other players' bars are never
// drawn. Enemies show an HP bar only once damaged. Props never carry one.

const BAR_W = 21; // inner fill length (~30% longer than the original 16)
const BAR_H = 1.5; // inner fill height (each bar thin — half the previous 3)
const BAR_GAP = 1; // px between sprite top and bar (tucked close to the head)
const DEFAULT_SPRITE_H = 24;

function healthColor(ratio: number): string {
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  if (ratio <= 0.3) return 'rgb(216,40,24)';
  if (ratio >= 0.5) {
    const t = (1 - ratio) / 0.5; // 0 at full -> 1 at half
    return `rgb(${lerp(48, 232, t)},${lerp(192, 208, t)},${lerp(48, 32, t)})`;
  }
  const t = (0.5 - ratio) / 0.2; // yellow -> red across 50%..30%
  return `rgb(${lerp(232, 216, t)},${lerp(208, 40, t)},${lerp(32, 24, t)})`;
}

// Dark blue at full PP -> light blue when low.
function ppColor(ratio: number): string {
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const t = 1 - Math.max(0, Math.min(1, ratio)); // 0 at full -> 1 at empty
  return `rgb(${lerp(36, 150, t)},${lerp(72, 210, t)},${lerp(210, 255, t)})`;
}

// Bright gold at full stamina -> dim amber when low.
function staminaColor(ratio: number): string {
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const t = 1 - Math.max(0, Math.min(1, ratio)); // 0 at full -> 1 at empty
  return `rgb(${lerp(248, 150, t)},${lerp(216, 120, t)},${lerp(40, 24, t)})`;
}

// One capsule bar: a rounded-rect black frame with the colored fill clipped to
// it. `topR`/`bottomR` are the corner radii for each end (logical px) — the
// outer end is fully rounded; the inner (shared-divider) end gets a small radius
// so a pixel is trimmed off each side of the divider, reading as two pills
// kissing. Antialiased but CLEAN (the 2x supersampled backbuffer smooths it).
function drawBarCapsule(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ratio: number,
  color: string,
  topR: number,
  bottomR: number,
  pend?: { ratio: number; color: string }
): void {
  const B = 0.5; // black frame thickness
  const w = BAR_W + 2 * B;
  const h = BAR_H + 2 * B;
  ctx.save();
  ctx.beginPath();
  // roundRect corner order: [top-left, top-right, bottom-right, bottom-left].
  ctx.roundRect(x, y, w, h, [topR, topR, bottomR, bottomR]);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.clip(); // the fill can't spill past the capsule
  // Pending (rolling) chunk first: the soon-to-drain HP sits BEHIND the real fill,
  // so the bright flash shows in the gap between current HP and where the bar's
  // still catching down to (EB rolling-counter look).
  if (pend && pend.ratio > ratio) {
    const pf = Math.round(pend.ratio * BAR_W);
    ctx.fillStyle = pend.color;
    ctx.fillRect(x + B, y + B, pf, BAR_H);
  }
  const fill = Math.round(ratio * BAR_W);
  if (fill > 0) {
    ctx.fillStyle = color;
    ctx.fillRect(x + B, y + B, fill, BAR_H);
  }
  ctx.restore();
}

// The flashing color of the soon-to-drain (pending) HP chunk: pulses between a
// hot white and the damage red so the lost amount reads on the bar before the
// roll takes it away (EB rolling-counter feel). `f` is 0..1 from pendFlash.
function pendColor(f: number): string {
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(216, 255, f)},${lerp(40, 230, f)},${lerp(24, 120, f)})`;
}

// `ppRatio` (0..1) is supplied ONLY for the local player — when present, a PSI
// capsule sits flush beneath the HP capsule, sharing one black divider line.
// `hpHolder` (when given) drives the rolling fill: the bar shows the real HP
// fill with the soon-to-drain chunk flashing behind it, advanced each frame.
function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  feetY: number,
  spriteGroupId: number,
  ratio: number,
  ppRatio?: number,
  hpHolder?: HpHolder,
  staminaRatio?: number
): void {
  const spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
  const B = 0.5;
  const h = BAR_H + 2 * B; // one capsule's height
  const R = h / 2; // outer end: fully rounded
  const INNER_R = 1; // inner end: small radius — trims a px off each divider side
  const hasPP = ppRatio !== undefined;
  const hasStam = staminaRatio !== undefined;
  const total = h + (hasPP ? h : 0) + (hasStam ? h : 0); // flush stack, no gaps
  const x = centerX - BAR_W / 2 - B;
  const y = feetY - spriteH - BAR_GAP - total;
  // Rolling pending chunk: advance displayHp toward real HP this frame, then draw
  // the lagging part as a flashing band behind the real fill while it catches down.
  let pend: { ratio: number; color: string } | undefined;
  if (hpHolder && hpHolder.maxHp > 0) {
    const tnow = performance.now();
    rollHealth(hpHolder, tnow);
    const dispRatio = Math.max(
      0,
      Math.min(1, (hpHolder.displayHp ?? hpHolder.hp) / hpHolder.maxHp)
    );
    if (dispRatio > ratio + 0.001) pend = { ratio: dispRatio, color: pendColor(pendFlash(tnow)) };
  }
  // HP rounds its top fully; its inner (bottom) end is lightly rounded when any bar
  // sits below it, or fully rounded when it's the only bar (enemies, no PP/stamina).
  const hpHasBelow = hasPP || hasStam;
  drawBarCapsule(ctx, x, y, ratio, healthColor(ratio), R, hpHasBelow ? INNER_R : R, pend);
  if (hasPP) {
    // PP is the middle pill when stamina is present (both ends lightly rounded);
    // otherwise it's the bottom (fully rounded foot).
    drawBarCapsule(ctx, x, y + h, ppRatio, ppColor(ppRatio), INNER_R, hasStam ? INNER_R : R);
  }
  if (hasStam) {
    // Stamina always sits at the bottom of the stack: lightly-rounded top, full foot.
    const sy = y + h + (hasPP ? h : 0);
    drawBarCapsule(ctx, x, sy, staminaRatio, staminaColor(staminaRatio), INNER_R, R);
  }
}

// The player's name in the EB font, centered just above the health bar, with a
// "Lv5" plate tucked to the LEFT of the bars. `barCount` is how many capsules the
// stack is (1 for others, 3 for your own HP+PSI+stamina) so the name clears it.
function drawNameplate(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  feetY: number,
  spriteGroupId: number,
  name: string,
  level: number,
  barCount: number,
  pk = false
): void {
  const plate = getNameplate(name, level, pk);
  if (!plate) return;
  const spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
  const capsule = BAR_H + 1; // one bar capsule (matches drawHealthBar's h)
  const barTop = feetY - spriteH - BAR_GAP - barCount * capsule;
  // Draw at half logical size: the 2x supersampled backbuffer still renders the
  // 8px font as crisp whole pixels, but it's half the on-screen height.
  const w = plate.width / 2;
  const h = plate.height / 2;
  const x = Math.round(centerX - w / 2);
  const y = Math.round(barTop - h);
  ctx.drawImage(plate, x, y, w, h);

  // "Lv5" sits left of the bars, vertically centered on the bar stack.
  const lvl = getLevelPlate(level, pk);
  if (lvl) {
    const lw = lvl.width / 2;
    const lh = lvl.height / 2;
    const B = 0.5;
    const barLeft = centerX - BAR_W / 2 - B;
    const lx = Math.round(barLeft - lw + 1); // tucked right up against the bars
    const ly = Math.round(barTop + (barCount * capsule) / 2 - lh / 2);
    ctx.drawImage(lvl, lx, ly, lw, lh);
  }
}

// Status-condition pips: a small color-coded square per active status, drawn
// just right of the bar stack (mirror of the Lv plate on the left). Color per
// status id (mirror of server/status.js STATUS). Cheap, no art needed; real
// icons are a later polish.
const STATUS_PIP_COLOR: Record<string, string> = {
  paralysis: '#ffe14d', // yellow — numb
  sleep: '#66ccff', // cyan
  diamond: '#dffbff', // pale white-blue
  strange: '#ff66cc', // magenta
  possessed: '#b07cff', // purple
  noPsi: '#88aaff', // blue
  crying: '#7799ff', // soft blue
  poison: '#66ee66', // green
  burn: '#ff5522', // fire red-orange
  nauseous: '#cccc66', // olive
  sunstroke: '#ff9933', // orange
  cold: '#aaddff', // light blue
  homesick: '#ffaacc', // pink
};

// An afflicted entity gets a bobbing emoji over its head per active status —
// reads instantly, far clearer than a colored pip, and needs no art. Drawn with
// the system emoji font (color glyph). KEEP IN SYNC with server/status.js STATUS.
const STATUS_EMOJI: Record<string, string> = {
  paralysis: '😵', // numb / stunned
  sleep: '💤',
  diamond: '💎', // solidified
  strange: '💫', // feeling strange
  possessed: '👻',
  noPsi: '🚫', // can't concentrate
  crying: '😢',
  poison: '☠️',
  burn: '🔥',
  nauseous: '🤢',
  sunstroke: '🥵',
  cold: '🤧',
  homesick: '🏠',
};
// Draw order (worst/most-important first) + how many to show before we fall back
// to pips for the overflow, so a multi-status entity never turns into emoji soup.
const STATUS_EMOJI_ORDER = [
  'diamond',
  'paralysis',
  'sleep',
  'burn',
  'poison',
  'sunstroke',
  'cold',
  'nauseous',
  'strange',
  'possessed',
  'crying',
  'noPsi',
  'homesick',
];
const STATUS_EMOJI_MAX = 3; // more than this → the rest show as pips
const STATUS_EMOJI_PX = 12;
const STATUS_EMOJI_DROP = 8; // px below the sprite top — sits on the head/face

/** Draw up to STATUS_EMOJI_MAX status emojis in a row over the head; returns the
 *  set of status ids it drew (so pips can skip them). */
function drawStatusEmojis(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  feetY: number,
  spriteGroupId: number,
  statuses: string[]
): Set<string> {
  const drawn = new Set<string>();
  const shown = STATUS_EMOJI_ORDER.filter((s) => statuses.includes(s) && STATUS_EMOJI[s]).slice(
    0,
    STATUS_EMOJI_MAX
  );
  if (!shown.length) return drawn;
  const spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
  const bob = Math.sin(performance.now() / 180); // gentle hover over the head
  const y = feetY - spriteH + STATUS_EMOJI_DROP + bob;
  const step = STATUS_EMOJI_PX; // horizontal spacing between glyphs
  const startX = centerX - ((shown.length - 1) * step) / 2;
  ctx.save();
  ctx.font = `${STATUS_EMOJI_PX}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  shown.forEach((s, i) => {
    ctx.fillText(STATUS_EMOJI[s], startX + i * step, y);
    drawn.add(s);
  });
  ctx.restore();
  return drawn;
}

function drawStatusPips(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  feetY: number,
  spriteGroupId: number,
  barCount: number,
  statuses: string[] | undefined
): void {
  if (!statuses || statuses.length === 0) return;
  // Each active status shows as a bobbing emoji over the head; anything past the
  // emoji cap (or an unmapped id) falls back to a compact color pip by the bar.
  const shown = drawStatusEmojis(ctx, centerX, feetY, spriteGroupId, statuses);
  const pips = statuses.filter((s) => !shown.has(s));
  if (pips.length === 0) return;
  const spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
  const capsule = BAR_H + 1;
  const barTop = feetY - spriteH - BAR_GAP - barCount * capsule;
  const PIP = 2.5;
  const GAP = 1;
  const barRight = centerX + BAR_W / 2 + 0.5;
  let x = Math.round(barRight + 1);
  const y = barTop + (barCount * capsule) / 2 - PIP / 2;
  for (const s of pips) {
    ctx.fillStyle = '#101018'; // 1px dark backing so pale pips stay legible
    ctx.fillRect(x - 0.5, y - 0.5, PIP + 1, PIP + 1);
    ctx.fillStyle = STATUS_PIP_COLOR[s] ?? '#bbbbbb';
    ctx.fillRect(x, y, PIP, PIP);
    x += PIP + GAP;
  }
}

// Buff HUD: per-stat label + color for the local player's active timed buffs.
// KEEP IN SYNC with server/buffs.js BUFF_STATS.
const BUFF_META: Record<string, { label: string; color: string }> = {
  offense: { label: 'ATK', color: '#ff7a7a' },
  defense: { label: 'DEF', color: '#7aa6ff' },
  speed: { label: 'SPD', color: '#7affa0' },
  guts: { label: 'GUT', color: '#ffd27a' },
  vitality: { label: 'VIT', color: '#ff9ed2' },
  iq: { label: 'IQ', color: '#c79cff' },
  luck: { label: 'LCK', color: '#9cf0ff' },
};

/** Screen-space buff HUD (top-left): one chip per active local buff —
 *  a colored bar, "STAT +N", and a live seconds countdown. Drawn in logical
 *  256x224 coords (after the world pass), text at half scale to match nameplates. */
function drawBuffHud(
  ctx: CanvasRenderingContext2D,
  buffs: { stat: string; amount: number; expiresAt: number }[] | undefined,
  shields: { kind: string; mode: string; hits: number }[] | undefined,
  now: number
): void {
  let rowI = 0;
  const chip = (text: string, color: string) => {
    const tw = Math.ceil(measureText(text, 1) * 0.5);
    const y = 4 + rowI * 11;
    const w = tw + 9;
    ctx.fillStyle = '#0d1016d9'; // dark chip backing
    ctx.fillRect(3, y, w, 9);
    ctx.fillStyle = color; // colored bar on the left edge
    ctx.fillRect(3, y, 2, 9);
    ctx.save();
    ctx.scale(0.5, 0.5); // draw the 16px font at 8px to match the nameplates
    drawText(ctx, text, 14, y * 2 + 1, 1, 1);
    ctx.restore();
    rowI++;
  };
  for (const b of buffs ?? []) {
    const remain = b.expiresAt - now;
    if (remain <= 0) continue; // expired locally; server resend will prune it
    const meta = BUFF_META[b.stat] ?? { label: b.stat.slice(0, 3).toUpperCase(), color: '#dddddd' };
    const sign = b.amount >= 0 ? '+' : '';
    chip(`${meta.label} ${sign}${b.amount}  ${Math.ceil(remain / 1000)}s`, meta.color);
  }
  // Shield chips: guarded kind, block/reflect marker, remaining charges.
  for (const s of shields ?? []) {
    if (s.hits <= 0) continue;
    const label = s.kind === 'psi' ? 'PSI-SH' : 'SHIELD';
    const mark = s.mode === 'reflect' ? 'REFLECT' : 'BLOCK';
    const color = s.kind === 'psi' ? '#7ad6ff' : '#9fbaff';
    chip(`${label} ${mark} x${s.hits}`, color);
  }
}

// EB credits font (16x6 grid, fixed-width 8x16 cells) — the KO "give up" prompt
// and the downed revive countdown both render in it. Loaded in Game.boot.
const KO_FONT = 'credits';

/** Seconds-remaining counter floated just above a downed body (player or ally). */
function drawDownedCountdown(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  feetY: number,
  spriteGroupId: number,
  downedUntil: number,
  now: number
): void {
  const remain = Math.max(0, Math.ceil((downedUntil - now) / 1000));
  const spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
  const text = `${remain}`;
  // Credits font at half scale keeps the over-head counter the same ~8px size.
  const tw = measureText(text, KO_FONT) * 0.5;
  const x = Math.round(centerX - tw / 2);
  const y = Math.round(feetY - spriteH - 7);
  ctx.fillStyle = '#101018cc';
  ctx.beginPath();
  ctx.roundRect(x - 2, y - 1, Math.ceil(tw) + 4, 10, 3);
  ctx.fill();
  ctx.save();
  ctx.scale(0.5, 0.5);
  drawText(ctx, text, x * 2, y * 2 + 1, KO_FONT, 1);
  ctx.restore();
}

/** Owner-only "dying" vignette: a transparent hole centered on the player over a
 *  black tint. As t goes 0→1 (full window → death) the hole shrinks toward the
 *  player and the tint deepens to solid black. Drawn screen-space (logical). */
function drawDownedVignette(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  t: number
): void {
  const holeR = 130 - 124 * t; // 130px wide → 6px tight on the player
  const tint = 0.3 + 0.7 * t; // → fully black at the end
  const inner = Math.max(1, holeR * 0.45);
  const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, Math.max(inner + 1, holeR));
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${tint.toFixed(3)})`);
  ctx.fillStyle = g; // beyond holeR the gradient extends its last stop = full tint
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
}

/** Bottom-center "hold to give up the ghost" prompt + fill meter (0..1). Sits
 *  ABOVE the bottom hotbar (16px tall, flush to the bottom edge — see
 *  hotbarLayout) so the meter and label never overlap the quick-select slots. */
function drawGiveUpPrompt(ctx: CanvasRenderingContext2D, progress: number): void {
  const w = 90;
  const h = 6;
  const HOTBAR_CLEARANCE = 16 + 8; // hotbar box height + gap above it
  const x = Math.round((SCREEN_WIDTH - w) / 2);
  const y = SCREEN_HEIGHT - HOTBAR_CLEARANCE - h;
  // Credits font cells are small (8x16), so draw at native scale and center the
  // label horizontally over the meter.
  const label = 'HOLD TO GIVE UP';
  const tw = measureText(label, KO_FONT, 1);
  const tx = Math.round((SCREEN_WIDTH - tw) / 2);
  drawText(ctx, label, tx, y - getLineHeight(KO_FONT) - 2, KO_FONT, 1);
  ctx.fillStyle = '#222';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#d8443a';
  ctx.fillRect(x, y, Math.round(w * Math.max(0, Math.min(1, progress))), h);
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  // Integer CSS upscale factor (256x224 -> on-screen size).
  private scale = 1;
  // Portrait-only reserved height (px) at the bottom for touch controls; the canvas
  // shrinks to fit above it and is centered there via a bottom margin. 0 otherwise.
  private controlBand = 0;
  // True only while the editor zoom is active — the backbuffer renders at full
  // display resolution so zoom-out stays crisp.
  private highRes = false;
  // Gameplay supersample. The backbuffer is gameSS× the logical 256x224 and CSS
  // magnifies it gameSS× LESS, so integer-positioned art (sprites, tiles,
  // bitmap text) is byte-for-byte identical on screen while sub-logical-pixel
  // detail — e.g. a half-pixel health-bar border — becomes drawable. Editor
  // zoom overrides this with full display res.
  private readonly gameSS = 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resizeToFit();
    window.addEventListener('resize', () => this.resizeToFit());
    // Mobile: the URL bar showing/hiding and orientation flips change the usable
    // area without always firing 'resize' — track the visual viewport too so the
    // game re-fills the screen.
    window.visualViewport?.addEventListener('resize', () => this.resizeToFit());
    window.addEventListener('orientationchange', () => this.resizeToFit());
  }

  private resizeToFit() {
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    // Touch + portrait: reserve a band at the bottom for the on-screen controls
    // (joystick + A/B/X/Y), then fit the canvas into the space ABOVE it and center
    // it there (applyBackbuffer sets the margin). This keeps the game and the
    // controls from overlapping on any portrait aspect ratio. Landscape and desktop
    // use the full height (band = 0). The band tracks the control cluster's height
    // (~46vmin = 0.46·vw in portrait) with a vh cap so it never eats the whole
    // screen on a near-square display. 0.46·vw sits just above the control cluster's
    // tallest point (the X button at ~43.5vmin) so only a tiny gap shows between the
    // game and the buttons.
    const portrait = vh > vw;
    this.controlBand = isTouchDevice() && portrait ? Math.min(vw * 0.46, vh * 0.5) : 0;
    const availH = vh - this.controlBand;
    const fit = Math.min(vw / SCREEN_WIDTH, availH / SCREEN_HEIGHT);
    // Desktop keeps integer scaling for pixel-perfect art. On phones/tablets a
    // floored scale bottoms out at 1× on a narrow screen — a 256×224 postage
    // stamp — so we fill the screen with the exact fractional fit instead. The
    // uneven-pixel artifact that normally argues for integer scaling is
    // imperceptible at the high device-pixel-ratio of a phone.
    this.scale = isTouchDevice() ? fit : Math.max(1, Math.floor(fit));
    this.applyBackbuffer();
  }

  /**
   * Size the backbuffer. Gameplay uses a gameSS× supersampled buffer (CSS
   * magnifies it correspondingly less with image-rendering: pixelated — so the
   * look stays chunky but half-pixel detail is drawable). Editor zoom uses a
   * full-resolution buffer so shrinking the world stays sharp. On-screen CSS
   * size is identical either way. Resizing clears context state, so re-assert
   * smoothing.
   */
  private applyBackbuffer() {
    const res = this.highRes ? this.scale : this.gameSS;
    this.canvas.width = SCREEN_WIDTH * res;
    this.canvas.height = SCREEN_HEIGHT * res;
    this.canvas.style.width = `${SCREEN_WIDTH * this.scale}px`;
    this.canvas.style.height = `${SCREEN_HEIGHT * this.scale}px`;
    // Portrait control band: a bottom margin equal to the band shifts the canvas up
    // to sit CENTERED in the area above the band (the position that looked right).
    // We then publish --tc-lift = a quarter of the remaining top slack, which the
    // touch overlay uses to raise the controls so they sit centered in the empty
    // space below the canvas instead of glued to the screen's bottom edge.
    if (this.controlBand) {
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const cssH = SCREEN_HEIGHT * this.scale;
      const lift = Math.max(0, (vh - this.controlBand - cssH) / 4);
      this.canvas.style.marginTop = '';
      this.canvas.style.marginBottom = `${this.controlBand}px`;
      document.documentElement.style.setProperty('--tc-lift', `${lift}px`);
    } else {
      this.canvas.style.marginTop = '';
      this.canvas.style.marginBottom = '';
      document.documentElement.style.setProperty('--tc-lift', '0px');
    }
    this.ctx.imageSmoothingEnabled = false;
    // The canvas just moved/resized — re-anchor the corner mute button to it.
    // This is the ONLY place the canvas's CSS size is set, and it runs on the
    // initial sizing (in the constructor) plus every resize, so the button is
    // always glued to the real game-view corner.
    syncMuteButtonPosition();
  }

  /** Logical→backbuffer scale in effect (gameSS for gameplay, scale in editor). */
  private get baseScale(): number {
    return this.highRes ? this.scale : this.gameSS;
  }

  /**
   * Set the base transform for non-gameplay screens (character select, loading)
   * that draw straight onto the canvas without going through render(). Without
   * this they'd draw at 1:1 into the supersampled buffer and fill only a corner.
   */
  prepareUI(): void {
    this.ctx.setTransform(this.baseScale, 0, 0, this.baseScale, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  render(
    camera: Camera,
    player: Player,
    remotePlayers: Map<string, RemotePlayer>,
    npcs: NPC[] = []
  ) {
    // Switch backbuffer resolution only when entering/leaving editor zoom, so
    // gameplay rendering (and text) is byte-for-byte the same as before.
    const wantHighRes = camera.zoom !== 1;
    if (wantHighRes !== this.highRes) {
      this.highRes = wantHighRes;
      this.applyBackbuffer();
    }
    // Base transform: scale logical 256x224 coords onto the larger backbuffer
    // (gameSS× for gameplay, the integer display scale in editor zoom).
    const baseScale = this.baseScale;
    this.ctx.setTransform(baseScale, 0, 0, baseScale, 0, 0);
    this.ctx.imageSmoothingEnabled = false;

    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    // Editor zoom: scale the whole world pass so zoom<1 shows more map in
    // the same canvas. Gameplay always renders at zoom 1 (identity scale).
    const vw = camera.viewW;
    const vh = camera.viewH;
    this.ctx.save();
    this.ctx.scale(camera.zoom, camera.zoom);

    const { startCol, startRow, endCol, endRow } = camera.getVisibleTileRange();

    // Snap the camera to whole pixels ONCE, and position the world, the player,
    // and every other entity relative to this same integer. The camera tracks
    // the player exactly, so on diagonals (player moves a non-integer ~1.414
    // px/frame) the world and the player must round against a shared origin —
    // otherwise the world shimmers 1px/2px under a pinned player. With a single
    // camX/camY everything scrolls in lockstep and the jitter disappears.
    const camX = Math.round(camera.x);
    const camY = Math.round(camera.y);

    // Hit-flash window: a sprite whose flashUntil is still ahead of `now` blinks
    // white this frame (set by Juice.FLASH_MS when it took damage).
    const now = Date.now();

    // In interiors, clip everything to the current room's tiles so adjacent
    // rooms (packed next to each other on the map) stay hidden behind black.
    const room = camera.roomBounds;
    if (room) {
      this.ctx.save();
      this.ctx.beginPath();
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          if (!room.tiles.has(row * MAP_WIDTH_TILES + col)) continue;
          this.ctx.rect(col * TILE_SIZE - camX, row * TILE_SIZE - camY, TILE_SIZE, TILE_SIZE);
        }
      }
      this.ctx.clip();
    }

    // Pass 1: Draw all tiles as background
    if (showBg) {
      // Custom-room band (below the overworld): arrangement 0 is empty/void, not
      // a real tile. Leave those cells black instead of drawing the tileset's
      // tile-0 graphic (which reads as a stray wall under unpainted room space).
      const bandRow = getOverworldHeightTiles();
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          const sector = getSectorForTile(col, row);
          if (!sector) continue;
          const arrangementId = getTileAt(col, row);
          if (arrangementId === 0 && row >= bandRow) continue;
          const screenX = col * TILE_SIZE - camX;
          const screenY = row * TILE_SIZE - camY;
          if (isComposite(arrangementId)) {
            drawComposite(this.ctx, arrangementId, screenX, screenY);
          } else {
            drawTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, screenX, screenY);
          }
        }
      }
    }

    // Depth model: ALL sprites draw in ONE feet-Y-sorted pass, so a sprite in
    // front (larger feet-Y) always paints over one behind it — sprite-vs-sprite
    // is pure Y-sort. The FG layer (native foreground tiles + "Behind"/0x40
    // promoted BG tiles) is then re-drawn over each sprite's own footprint to
    // occlude the parts flagged behind it: bit 0x01 = LOWER half behind FG (tall
    // grass, counters), 0x02 = WHOLE body behind FG (canopies, behind a
    // building). This replaces the old two-bucket (behind-FG / above-FG) split,
    // which forced EVERY above-FG sprite to paint after EVERY behind-FG one —
    // so an NPC behind you rendered on top whenever you stood on a flagged tile.
    // showFg (editor layer toggle) hides the FG layer AND its per-sprite re-cover.
    const drawFG = camera.zoom >= FG_PASS_MIN_ZOOM && showFg;

    // One drawable sprite: feet-Y sort key, FG-priority bits, part + bar draws.
    interface SpriteJob {
      worldX: number;
      feetY: number;
      local: boolean; // the local player wins feet-Y ties (draws on top)
      pri: number;
      drawPart: (part: SpritePart) => void;
      drawBar?: () => void;
    }
    const jobs: SpriteJob[] = [];
    const addSprite = (
      worldX: number,
      worldY: number,
      drawPart: (part: SpritePart) => void,
      drawBar?: () => void,
      local = false
    ) => {
      jobs.push({
        worldX,
        feetY: worldY,
        local,
        pri: getSpritePriority(worldX, worldY),
        drawPart,
        drawBar,
      });
    };

    // Draws any entity (local/remote player OR an NPC) plus its held-item
    // overlay. The item sits at hand height (the sprite's lower half), so when
    // priority flags split the sprite it rides along with the 'lower'/'full'
    // part. Facing away puts the item in the far hand — drawn under the body.
    // Pass itemId null for an empty-handed sprite (most NPCs / unarmed players).
    const drawEntityPart = (
      groupId: number,
      direction: number,
      frame: number,
      pose: Pose,
      itemId: string | null,
      sx: number,
      sy: number,
      part: SpritePart,
      flash: boolean,
      downedAngle?: number,
      sink = 0
    ) => {
      const meta = getSpriteGroupMeta(groupId);
      const h = meta?.height ?? DEFAULT_SPRITE_H;
      const w = meta?.width ?? 16;
      // Death sink: in its final seconds a downed body slides STRAIGHT DOWN into
      // the floor (mirrors DeathFx). `sink` is px descended; everything below a
      // FIXED screen-space mask at the resting ground line is clipped away, so the
      // body slides under the floor instead of just dropping. The flat (rotated)
      // body's bottom edge at rest sits at restY - h/2 + w/2 (w = rotated extent).
      let clipped = false;
      let feetY = sy;
      if (sink > 0) {
        feetY = sy + Math.round(sink);
        const maskY = sy - h / 2 + w / 2;
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(sx - 64, maskY - 256, 128, 256);
        this.ctx.clip();
        clipped = true;
      }
      // Downed = KO'd: rotate the whole sprite around its mid so it lays on its
      // back. `downedAngle` is the live KO-throw angle (tweens 0→±90°, see
      // KoThrow); undefined = upright. Each FG-priority part rotates around the
      // SAME pivot, so the slices still compose into one coherent rotated body.
      if (downedAngle !== undefined) {
        const px = sx;
        const py = feetY - h / 2;
        this.ctx.save();
        this.ctx.translate(px, py);
        this.ctx.rotate(downedAngle);
        this.ctx.translate(-px, -py);
      }
      const itemHere = itemId !== null && part !== 'upper';
      if (itemHere && isItemBehind(direction)) {
        drawHeldItem(this.ctx, itemId!, direction, frame, pose, sx, feetY);
      }
      drawSprite(this.ctx, groupId, direction, frame, sx, feetY, part, pose, flash);
      if (itemHere && !isItemBehind(direction)) {
        drawHeldItem(this.ctx, itemId!, direction, frame, pose, sx, feetY);
      }
      if (downedAngle !== undefined) this.ctx.restore();
      if (clipped) this.ctx.restore();
    };

    // KO throw render offset (screen px) + rotation for a downed body. The body,
    // its countdown, and (owner) the vignette all ride this offset so they stay
    // together as it's flung + bounces, then rest. Upright entity → null.
    const koDraw = (e: {
      downed?: boolean;
      koThrow?: KoThrowState;
    }): { ox: number; oy: number; angle: number } | null => {
      if (!e.downed) return null;
      const k = e.koThrow;
      if (!k) return { ox: 0, oy: 0, angle: Math.PI / 2 };
      return { ox: Math.round(k.offX), oy: Math.round(k.offY - k.z), angle: k.angle };
    };

    // Death sink (everyone sees it): the body slides into the ground for its final
    // exit, the same as a slain NPC (DeathFx). TWO drivers, whichever is further —
    // mirroring the vignette (t = max(timeT, giveUpProgress)):
    //   • the clock running out  — sink over the last SINK_WINDOW_MS
    //   • holding to give up      — sink over the last (1 - GU_SINK_START) of the hold,
    //     so the body is fully swallowed exactly as the give-up vignette hits black.
    // Returns px descended (fed to drawEntityPart's `sink`), past the sprite's
    // width so the rotated body is fully under by the end.
    const SINK_WINDOW_MS = 3000;
    const GU_SINK_START = 0.7;
    const sinkPx = (
      e: { downed?: boolean; downedUntil?: number; spriteGroupId: number },
      giveUp = 0
    ): number => {
      if (!e.downed) return 0;
      let p = 0;
      if (e.downedUntil !== undefined) {
        const remain = e.downedUntil - now;
        if (remain <= SINK_WINDOW_MS) p = Math.max(0, Math.min(1, 1 - remain / SINK_WINDOW_MS));
      }
      if (giveUp > GU_SINK_START) p = Math.max(p, (giveUp - GU_SINK_START) / (1 - GU_SINK_START));
      if (p <= 0) return 0;
      const w = getSpriteGroupMeta(e.spriteGroupId)?.width ?? 16;
      return p * (w + 2);
    };

    const playerSx = Math.round(player.x) - camX;
    const playerSy = Math.round(player.y) - camY;
    addSprite(
      player.x,
      player.y,
      (part) => {
        const ko = koDraw(player);
        drawEntityPart(
          player.spriteGroupId,
          player.direction,
          player.frame,
          player.pose,
          player.heldItemId,
          playerSx + (ko?.ox ?? 0),
          playerSy + (ko?.oy ?? 0),
          part,
          player.flashUntil > now,
          ko?.angle,
          sinkPx(player, player.giveUpProgress)
        );
      },
      () => {
        // Downed: show the revive countdown over the body instead of bars.
        if (player.downed) {
          const ko = koDraw(player);
          drawDownedCountdown(
            this.ctx,
            playerSx + (ko?.ox ?? 0),
            playerSy + (ko?.oy ?? 0),
            player.spriteGroupId,
            player.downedUntil,
            now
          );
          return;
        }
        // Your own bar: HP + a PSI bar beneath it (PP from the authoritative
        // stats mirror). Only you see the PSI bar; the nameplate sits above it.
        const s = getStatus();
        const ppRatio = s.ppMax > 0 ? Math.max(0, Math.min(1, s.pp / s.ppMax)) : 0;
        const staminaRatio =
          s.staminaMax > 0 ? Math.max(0, Math.min(1, s.stamina / s.staminaMax)) : 0;
        drawHealthBar(
          this.ctx,
          playerSx,
          playerSy,
          player.spriteGroupId,
          player.healthRatio,
          ppRatio,
          player,
          staminaRatio
        );
        drawNameplate(
          this.ctx,
          playerSx,
          playerSy,
          player.spriteGroupId,
          s.name,
          s.level,
          3, // HP + PP + stamina
          player.pk
        );
        drawStatusPips(this.ctx, playerSx, playerSy, player.spriteGroupId, 3, player.statuses);
      },
      true
    );

    for (const [, rp] of remotePlayers) {
      const rpScreenX = Math.round(rp.x) - camX;
      const rpScreenY = Math.round(rp.y) - camY;
      if (rpScreenX < -32 || rpScreenX > vw + 32) continue;
      if (rpScreenY < -48 || rpScreenY > vh + 48) continue;
      addSprite(
        rp.x,
        rp.y,
        (part) => {
          const ko = koDraw(rp);
          drawEntityPart(
            rp.spriteGroupId,
            rp.direction,
            rp.frame,
            rp.pose ?? 'walk',
            rp.itemId ?? null,
            rpScreenX + (ko?.ox ?? 0),
            rpScreenY + (ko?.oy ?? 0),
            part,
            (rp.flashUntil ?? 0) > now,
            ko?.angle,
            sinkPx(rp)
          );
        },
        () => {
          // Downed ally: show their revive countdown so others know to hurry.
          if (rp.downed) {
            const ko = koDraw(rp);
            drawDownedCountdown(
              this.ctx,
              rpScreenX + (ko?.ox ?? 0),
              rpScreenY + (ko?.oy ?? 0),
              rp.spriteGroupId,
              rp.downedUntil ?? now,
              now
            );
            return;
          }
          // Other players: an HP bar (no PSI — that's private) with their
          // name + level above it, so everyone can read who's who and how strong.
          const ratio = rp.maxHp ? Math.max(0, Math.min(1, (rp.hp ?? rp.maxHp) / rp.maxHp)) : 1;
          drawHealthBar(
            this.ctx,
            rpScreenX,
            rpScreenY,
            rp.spriteGroupId,
            ratio,
            undefined,
            rp.maxHp != null && rp.hp != null ? (rp as HpHolder) : undefined
          );
          drawNameplate(
            this.ctx,
            rpScreenX,
            rpScreenY,
            rp.spriteGroupId,
            rp.name,
            rp.level ?? 1,
            1, // remotes show only the HP capsule
            rp.pk ?? false
          );
          drawStatusPips(this.ctx, rpScreenX, rpScreenY, rp.spriteGroupId, 1, rp.statuses);
        }
      );
    }

    for (const npc of npcs) {
      const nScreenX = Math.round(npc.x) - camX;
      const nScreenY = Math.round(npc.y) - camY;
      if (nScreenX < -32 || nScreenX > vw + 32) continue;
      if (nScreenY < -48 || nScreenY > vh + 48) continue;
      // Props are scenery — only people/enemies/cars carry health bars, and a bar
      // is hidden at full HP (shown to everyone only once it drops below 100%).
      // Status pips show even at full HP (a paralyzed but undamaged enemy).
      const combatant = npc.kind === 'person' || npc.kind === 'enemy' || npc.kind === 'car';
      const showBar = combatant && npc.healthRatio < 1;
      const showPips = combatant && npc.statuses.length > 0;
      const drawBar =
        showBar || showPips
          ? () => {
              if (showBar)
                drawHealthBar(
                  this.ctx,
                  nScreenX,
                  nScreenY,
                  npc.spriteGroupId,
                  npc.healthRatio,
                  undefined,
                  npc
                );
              drawStatusPips(this.ctx, nScreenX, nScreenY, npc.spriteGroupId, 1, npc.statuses);
            }
          : undefined;
      addSprite(
        npc.x,
        npc.y,
        (part) =>
          drawEntityPart(
            npc.spriteGroupId,
            npc.direction,
            npc.frame,
            npc.pose,
            npc.itemId,
            nScreenX,
            nScreenY,
            part,
            npc.flashUntil > now
          ),
        drawBar
      );
    }

    // Ranged-weapon shots + impact sparks join the same Y-sorted sprite pass so
    // they respect layer depth: a shot flying behind a building/canopy (or behind
    // a sprite in front of it) is occluded instead of always painting on top. A
    // projectile is a point object, so ANY behind-FG priority hides the whole
    // thing — map a nonzero priority to the 0x02 "whole body behind" bit and let
    // the job loop's wholeBehind branch redraw the FG over it.
    const projSprites: ProjectileSprite[] = [];
    collectProjectileSprites(projSprites);
    for (const ps of projSprites) {
      jobs.push({
        worldX: ps.x,
        feetY: ps.y,
        local: false,
        pri: getSpritePriority(ps.x, ps.y) ? 0x02 : 0,
        drawPart: () => ps.draw(this.ctx, camX, camY),
      });
    }

    // Death throws (slain bodies tumbling + bouncing, see DeathFx) likewise join
    // the Y-sorted pass, so a corpse flung behind a building/canopy is occluded —
    // it sorts by its ground feet-Y like any other sprite.
    const deathSprites: DeathSprite[] = [];
    collectDeathSprites(deathSprites);
    for (const ds of deathSprites) {
      jobs.push({
        worldX: ds.x,
        feetY: ds.y,
        local: false,
        pri: getSpritePriority(ds.x, ds.y) ? 0x02 : 0,
        drawPart: () => ds.draw(this.ctx, camX, camY),
      });
    }

    // The native FG layer over the BG for areas with NO sprite (sprites re-cover
    // their own footprint below). Native foreground tiles are transparent except
    // their FG pixels; painted "Front"/0x40 tiles are handled separately by
    // drawPromotedFgPass() AFTER all sprites (a true over-everything FG layer).
    if (drawFG) {
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          const sector = getSectorForTile(col, row);
          if (!sector) continue;
          const arrangementId = getTileAt(col, row);
          if (isComposite(arrangementId)) {
            drawCompositeFg(
              this.ctx,
              arrangementId,
              col * TILE_SIZE - camX,
              row * TILE_SIZE - camY
            );
            continue;
          }
          if (!hasForegroundTile(sector.tilesetId, sector.paletteId)) continue;
          drawForegroundTile(
            this.ctx,
            sector.tilesetId,
            sector.paletteId,
            arrangementId,
            col * TILE_SIZE - camX,
            row * TILE_SIZE - camY
          );
        }
      }
    }

    // Ground loot lies flat ON the floor, so draw it AFTER the foreground tile
    // pass (else floor-detail FG pixels paint over a dropped item — a cookie on
    // the ground vanishing under the ground), but BEFORE the Y-sorted sprite pass
    // so players/NPCs still walk over it. It's never occluded by FG: a ground
    // item is always visible where it lies, like the ROM's item boxes.
    renderDrops(this.ctx, camX, camY);

    // Re-draw the FG layer over one sprite's footprint, occluding its behind-FG
    // part. Footprint = a box around the feet generous enough to cover the body
    // and the health bar above the head.
    const FG_COVER_HALF_W = 20; // px each side of the sprite centre
    const FG_COVER_UP = 56; // px above the feet (body + bar)
    const FG_COVER_DOWN = 2;
    const redrawFGOver = (worldX: number, feetY: number) => {
      if (!drawFG) return;
      const c0 = Math.max(startCol, Math.floor((worldX - FG_COVER_HALF_W) / TILE_SIZE));
      const c1 = Math.min(endCol, Math.floor((worldX + FG_COVER_HALF_W) / TILE_SIZE));
      const r0 = Math.max(startRow, Math.floor((feetY - FG_COVER_UP) / TILE_SIZE));
      const r1 = Math.min(endRow, Math.floor((feetY + FG_COVER_DOWN) / TILE_SIZE));
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const sector = getSectorForTile(col, row);
          if (!sector) continue;
          const arrangementId = getTileAt(col, row);
          const sx = col * TILE_SIZE - camX;
          const sy = row * TILE_SIZE - camY;
          // Minitiles painted "Background" (0x20): the entity draws on top of
          // them ONLY when its feet are fully in FRONT of (south of) the tile —
          // i.e. feet below the tile's BOTTOM edge. That's the player walking up
          // to a counter from the south (head over the counter). An entity whose
          // feet are level with the tile's row (an NPC clerk AT the counter) or
          // north of it (genuinely behind) is still occluded normally — the
          // counter draws over its feet — so don't clip it.
          const bg = getBackgroundMinitiles(col, row);
          const entityOnTop = bg.length > 0 && feetY >= (row + 1) * TILE_SIZE;
          if (entityOnTop && bg.length === 16) continue; // whole tile stays behind the entity
          const clipBg = entityOnTop;
          if (clipBg) {
            this.ctx.save();
            this.ctx.beginPath();
            for (let mi = 0; mi < 16; mi++) {
              if (bg.includes(mi)) continue;
              this.ctx.rect(
                sx + (mi % 4) * MINITILE_SIZE,
                sy + (mi >> 2) * MINITILE_SIZE,
                MINITILE_SIZE,
                MINITILE_SIZE
              );
            }
            this.ctx.clip();
          }
          if (isComposite(arrangementId)) {
            // Composites just re-cover their FG over the sprite; no behind/reveal.
            drawCompositeFg(this.ctx, arrangementId, sx, sy);
          } else if (hasForegroundTile(sector.tilesetId, sector.paletteId)) {
            drawForegroundTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, sx, sy);
          }
          if (clipBg) this.ctx.restore();
        }
      }
    };

    // Painted "Front" (0x40) tiles are a TRUE foreground layer. The promote bit
    // marks WHICH minitiles to lift to the front; here we copy that BG tile's art
    // (clipped to the promoted minitiles) onto a foreground pass drawn over the
    // WHOLE visible map AFTER every sprite — so anything standing where those
    // pixels are is genuinely behind them, fully opaque (no see-through).
    // Gated by drawFG, so the editor's FG layer toggle shows/hides these too.
    const drawPromotedFgPass = () => {
      if (!drawFG) return;
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          const mask = getPromotedMinitiles(col, row);
          if (mask.length === 0) continue;
          const sector = getSectorForTile(col, row);
          if (!sector) continue;
          const arrangementId = getTileAt(col, row);
          const sx = col * TILE_SIZE - camX;
          const sy = row * TILE_SIZE - camY;
          // Clip to just the painted minitiles, then draw the tile art — only the
          // Front cells show through, giving sub-tile (8px) precision.
          this.ctx.save();
          this.ctx.beginPath();
          for (const idx of mask) {
            this.ctx.rect(
              sx + (idx % 4) * MINITILE_SIZE,
              sy + (idx >> 2) * MINITILE_SIZE,
              MINITILE_SIZE,
              MINITILE_SIZE
            );
          }
          this.ctx.clip();
          // Composite (custom-room) cells assemble their art from mixed source
          // minitiles, so they draw through drawComposite, not drawTile.
          if (isComposite(arrangementId)) {
            drawComposite(this.ctx, arrangementId, sx, sy);
          } else {
            drawTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, sx, sy);
          }
          this.ctx.restore();
        }
      }
    };

    // Feet-Y order; the local player wins ties so you're never hidden under an
    // NPC you're standing level with.
    jobs.sort((a, b) => a.feetY - b.feetY || (a.local ? 1 : 0) - (b.local ? 1 : 0));
    if (showSprites) {
      for (const job of jobs) {
        const wholeBehind = (job.pri & 0x02) !== 0;
        const lowerHalfBehind = (job.pri & 0x01) !== 0;
        if (wholeBehind) {
          job.drawPart('full');
          job.drawBar?.(); // bar hides with the body
          redrawFGOver(job.worldX, job.feetY);
        } else if (lowerHalfBehind) {
          job.drawPart('lower');
          redrawFGOver(job.worldX, job.feetY);
          job.drawPart('upper');
          job.drawBar?.();
        } else {
          // In front of the native FG layer — drawn over the global FG pass above.
          job.drawPart('full');
          job.drawBar?.();
        }
      }
    }

    // Painted Front (0x40) tiles ride a foreground pass OVER all sprites, so the
    // player ends up genuinely behind whatever was lifted to the front.
    drawPromotedFgPass();

    // Black out minitiles of neighboring rooms that share an edge tile with
    // the current room (sub-tile leftovers of the room mask).
    if (room && room.holes.length > 0) {
      this.ctx.fillStyle = '#000';
      for (const hole of room.holes) {
        const hx = Math.round(hole.x) - camX;
        const hy = Math.round(hole.y) - camY;
        if (hx < -8 || hx > vw || hy < -8 || hy > vh) continue;
        this.ctx.fillRect(hx, hy, 8, 8);
      }
    }

    if (room) {
      this.ctx.restore();
    }

    // Collision/priority tint under the hit boxes, so both overlays read clearly.
    if (debugCollision) {
      this.drawCollisionLayers(camX, camY, vw, vh, camera.zoom);
    }

    if (debugBoxes) {
      this.drawDebugBoxes(camX, camY, player, remotePlayers, npcs);
    }

    this.ctx.restore(); // zoom scale

    // Local player's buff HUD — screen-space (logical coords), after the world.
    drawBuffHud(this.ctx, player.buffs, player.shields, now);

    // Downed: closing vignette + give-up prompt (owner only), over everything.
    if (player.downed) {
      const h = getSpriteGroupMeta(player.spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
      // Ride the KO-throw offset so the vignette stays centered on the flung body.
      const ko = koDraw(player);
      const cx = Math.round(player.x) - camX + (ko?.ox ?? 0);
      const cy = Math.round(player.y) - camY - h / 2 + (ko?.oy ?? 0);
      const total = player.downedTotalMs || 30000;
      // The vignette closes on TWO drivers, whichever is further along: the
      // natural time countdown, and the hold-to-give-up meter. Holding (red bar
      // grows) closes it faster toward black; releasing retracts it only back to
      // the time-based value, so it keeps closing in as the timer nears zero.
      const timeT = 1 - Math.max(0, Math.min(1, (player.downedUntil - now) / total));
      const t = Math.max(timeT, player.giveUpProgress);
      drawDownedVignette(this.ctx, cx, cy, t);
      drawGiveUpPrompt(this.ctx, player.giveUpProgress);
    }
  }

  /**
   * Draw the collision/priority overlay live over the world (editor header
   * "Collision" toggle). Mirrors CollisionTool.drawOverlay exactly — same
   * getEffectiveRowAt source and colors — so what you see in-game matches the
   * Priority Painter and the collision system: red = solid (0x80), blue = pri-lo
   * (0x01), purple = pri-hi (0x02), yellow = FG-promote/hide (0x40), orange =
   * force-background/on-top (0x20).
   */
  private drawCollisionLayers(camX: number, camY: number, vw: number, vh: number, zoom: number) {
    const ctx = this.ctx;
    const M = MINITILE_SIZE;
    const t0x = Math.floor(camX / TILE_SIZE);
    const t0y = Math.floor(camY / TILE_SIZE);
    const t1x = Math.ceil((camX + vw) / TILE_SIZE);
    const t1y = Math.ceil((camY + vh) / TILE_SIZE);
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const row = getEffectiveRowAt(tx, ty);
        if (!row) continue;
        const baseX = tx * TILE_SIZE - camX;
        const baseY = ty * TILE_SIZE - camY;
        for (let i = 0; i < 16; i++) {
          const b = row[i];
          if (b === 0) continue;
          const cx = baseX + (i % 4) * M;
          const cy = baseY + (i >> 2) * M;
          if (b & 0x80) {
            ctx.fillStyle = 'rgba(255,60,60,0.5)'; // solid → red
            ctx.fillRect(cx, cy, M, M);
            // Dark cross-hatch so solid reads clearly over busy tile art.
            ctx.strokeStyle = 'rgba(20,0,0,0.9)';
            ctx.lineWidth = 1 / zoom;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + M, cy + M);
            ctx.moveTo(cx + M, cy);
            ctx.lineTo(cx, cy + M);
            ctx.stroke();
          }
          if (b & 0x01) {
            ctx.fillStyle = 'rgba(70,130,255,0.55)'; // pri-lo → blue
            ctx.fillRect(cx, cy, M, M);
          }
          if (b & 0x02) {
            ctx.fillStyle = 'rgba(175,80,255,0.6)'; // pri-hi → purple
            ctx.fillRect(cx, cy, M, M);
          }
          if (b & FG_PROMOTE_BIT) {
            ctx.fillStyle = 'rgba(245,215,40,0.55)'; // behind/hide → yellow
            ctx.fillRect(cx, cy, M, M);
          }
          if (b & FORCE_BG_BIT) {
            ctx.fillStyle = 'rgba(255,140,40,0.55)'; // always-on-top → orange
            ctx.fillRect(cx, cy, M, M);
          }
        }
      }
    }
  }

  /**
   * Draw combat debug boxes (toggle: B key, or the editor header "Hitboxes"
   * button). Cyan = hurtbox (what an attack must overlap to land); blue =
   * collision/foot box (what blocks movement, per-entity `col` or the default);
   * red = the player's attack hitbox while a swing plays. Geometry mirrors
   * server/npcSim.js so what's drawn matches what the server resolves.
   */
  private drawDebugBoxes(
    camX: number,
    camY: number,
    player: Player,
    remotePlayers: Map<string, RemotePlayer>,
    npcs: NPC[]
  ) {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    const hurt = (x: number, y: number) => {
      ctx.strokeStyle = 'rgba(0,224,255,0.9)'; // cyan
      ctx.strokeRect(
        Math.round(x - HURT_W / 2) - camX + 0.5,
        Math.round(y + HURT_OY) - camY + 0.5,
        HURT_W,
        HURT_H
      );
    };
    const col = (sprite: number, x: number, y: number) => {
      const [bx, by, bw, bh] = colBoxFor(sprite, x, y);
      ctx.strokeStyle = 'rgba(96,160,255,0.9)'; // blue
      ctx.strokeRect(Math.round(bx) - camX + 0.5, Math.round(by) - camY + 0.5, bw, bh);
    };

    hurt(player.x, player.y);
    col(player.spriteGroupId, player.x, player.y);
    for (const [, rp] of remotePlayers) {
      hurt(rp.x, rp.y);
      col(rp.spriteGroupId, rp.x, rp.y);
    }
    for (const npc of npcs) {
      if (npc.kind === 'person' || npc.kind === 'enemy') {
        hurt(npc.x, npc.y);
        col(npc.spriteGroupId, npc.x, npc.y);
      } else if ((npc.kind === 'prop' || npc.kind === 'gift') && hasEntityCol(npc.spriteGroupId)) {
        // Harvested furniture / solid container: a prop or gift with an authored
        // col box is solid, so draw its blue collision box (matches blockedByNPC).
        // Hotspot props (no col) stay invisible in the overlay.
        col(npc.spriteGroupId, npc.x, npc.y);
      } else if (npc.kind === 'car') {
        // A vehicle's whole-body box is BOTH its collision box and its hurtbox
        // (server actorBox), so one rect serves both — drawn cyan since it's the
        // box a swing must overlap to wreck it.
        const b = carColBoxFor(npc.spriteGroupId, npc.direction, npc.x, npc.y);
        if (b) {
          ctx.strokeStyle = 'rgba(0,224,255,0.9)'; // cyan = hurt/collision
          ctx.strokeRect(Math.round(b[0]) - camX + 0.5, Math.round(b[1]) - camY + 0.5, b[2], b[3]);
        }
      }
    }

    // Player attack hitbox during a swing (same math as npcSim.handleAttack).
    if (player.pose === 'attack') {
      const v = DBG_DIR_VEC[player.direction] ?? DBG_DIR_VEC[Direction.S];
      const cx = player.x + v[0] * ATTACK_REACH;
      const cy = player.y - 10 + v[1] * ATTACK_REACH;
      ctx.strokeStyle = 'rgba(255,48,48,0.95)';
      ctx.strokeRect(
        Math.round(cx - ATTACK_HALF) - camX + 0.5,
        Math.round(cy - ATTACK_HALF) - camY + 0.5,
        ATTACK_HALF * 2,
        ATTACK_HALF * 2
      );
    }
  }
}
