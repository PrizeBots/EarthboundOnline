import { Camera } from './Camera';
import { Player } from './Player';
import { NPC } from './NPC';
import { getTileAt, getSectorForTile } from './MapManager';
import { colBoxFor, carColBoxFor } from './NPCManager';
import { drawTile, drawForegroundTile, hasForegroundTile } from './TilesetManager';
import { isComposite, drawComposite, drawCompositeFg } from './CompositeTiles';
import { drawSprite, getSpriteGroupMeta, SpritePart } from './SpriteManager';
import { getNameplate, getLevelPlate } from './NamePlate';
import { drawHeldItem, isItemBehind } from './Items';
import { renderDrops } from './DropManager';
import {
  getSpritePriority,
  getPromotedMinitiles,
  getEffectiveRowAt,
  FG_PROMOTE_BIT,
} from './Collision';
import { getStatus } from './StatusModal';
import { drawText, measureText } from './TextRenderer';
import {
  Pose,
  Direction,
  RemotePlayer,
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
const DBG_DIAG = Math.SQRT1_2;
// Indexed by Direction: S,N,W,E,NW,SW,SE,NE.
const DBG_DIR_VEC: [number, number][] = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
  [-DBG_DIAG, -DBG_DIAG],
  [-DBG_DIAG, DBG_DIAG],
  [DBG_DIAG, DBG_DIAG],
  [DBG_DIAG, -DBG_DIAG],
];

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
  bottomR: number
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
  const fill = Math.round(ratio * BAR_W);
  if (fill > 0) {
    ctx.fillStyle = color;
    ctx.fillRect(x + B, y + B, fill, BAR_H);
  }
  ctx.restore();
}

// `ppRatio` (0..1) is supplied ONLY for the local player — when present, a PSI
// capsule sits flush beneath the HP capsule, sharing one black divider line.
function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  feetY: number,
  spriteGroupId: number,
  ratio: number,
  ppRatio?: number
): void {
  const spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
  const B = 0.5;
  const h = BAR_H + 2 * B; // one capsule's height
  const R = h / 2; // outer end: fully rounded
  const INNER_R = 1; // inner end: small radius — trims a px off each divider side
  const hasPP = ppRatio !== undefined;
  const total = h + (hasPP ? h : 0); // flush — no gap between the two
  const x = centerX - BAR_W / 2 - B;
  const y = feetY - spriteH - BAR_GAP - total;
  // HP rounds its top fully; its inner (bottom) end is lightly rounded — or
  // fully rounded when it's the only bar (enemies, no PP).
  drawBarCapsule(ctx, x, y, ratio, healthColor(ratio), R, hasPP ? INNER_R : R);
  if (hasPP) {
    drawBarCapsule(ctx, x, y + h, ppRatio, ppColor(ppRatio), INNER_R, R);
  }
}

// The player's name in the EB font, centered just above the health bar, with a
// "Lv5" plate tucked to the LEFT of the bars. `hasPP` tells us whether the bar
// is one capsule (others) or two (your own HP+PSI) so the name clears it.
function drawNameplate(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  feetY: number,
  spriteGroupId: number,
  name: string,
  level: number,
  hasPP: boolean,
  pk = false
): void {
  const plate = getNameplate(name, level, pk);
  if (!plate) return;
  const spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
  const capsule = BAR_H + 1; // one bar capsule (matches drawHealthBar's h)
  const barCount = hasPP ? 2 : 1;
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
  nauseous: '#cccc66', // olive
  sunstroke: '#ff9933', // orange
  cold: '#aaddff', // light blue
  homesick: '#ffaacc', // pink
};

function drawStatusPips(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  feetY: number,
  spriteGroupId: number,
  hasPP: boolean,
  statuses: string[] | undefined
): void {
  if (!statuses || statuses.length === 0) return;
  const spriteH = getSpriteGroupMeta(spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
  const capsule = BAR_H + 1;
  const barCount = hasPP ? 2 : 1;
  const barTop = feetY - spriteH - BAR_GAP - barCount * capsule;
  const PIP = 2.5;
  const GAP = 1;
  const barRight = centerX + BAR_W / 2 + 0.5;
  let x = Math.round(barRight + 1);
  const y = barTop + (barCount * capsule) / 2 - PIP / 2;
  for (const s of statuses) {
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
  now: number
): void {
  if (!buffs || !buffs.length) return;
  let rowI = 0;
  for (const b of buffs) {
    const remain = b.expiresAt - now;
    if (remain <= 0) continue; // expired locally; server resend will prune it
    const meta = BUFF_META[b.stat] ?? { label: b.stat.slice(0, 3).toUpperCase(), color: '#dddddd' };
    const sign = b.amount >= 0 ? '+' : '';
    const text = `${meta.label} ${sign}${b.amount}  ${Math.ceil(remain / 1000)}s`;
    const tw = Math.ceil(measureText(text, 1) * 0.5);
    const y = 4 + rowI * 11;
    const w = tw + 9;
    ctx.fillStyle = '#0d1016d9'; // dark chip backing
    ctx.fillRect(3, y, w, 9);
    ctx.fillStyle = meta.color; // colored stat bar on the left edge
    ctx.fillRect(3, y, 2, 9);
    ctx.save();
    ctx.scale(0.5, 0.5); // draw the 16px font at 8px to match the nameplates
    drawText(ctx, text, 14, y * 2 + 1, 1, 1);
    ctx.restore();
    rowI++;
  }
}

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
  const tw = measureText(text, 1) * 0.5;
  const x = Math.round(centerX - tw / 2);
  const y = Math.round(feetY - spriteH - 7);
  ctx.fillStyle = '#101018cc';
  ctx.beginPath();
  ctx.roundRect(x - 2, y - 1, Math.ceil(tw) + 4, 10, 3);
  ctx.fill();
  ctx.save();
  ctx.scale(0.5, 0.5);
  drawText(ctx, text, x * 2, y * 2 + 1, 1, 1);
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
  ctx.save();
  ctx.scale(0.5, 0.5);
  drawText(ctx, 'HOLD DOWN TO GIVE UP', x * 2, (y - 11) * 2 + 1, 1, 1);
  ctx.restore();
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
  }

  private resizeToFit() {
    const scaleX = window.innerWidth / SCREEN_WIDTH;
    const scaleY = window.innerHeight / SCREEN_HEIGHT;
    this.scale = Math.max(1, Math.floor(Math.min(scaleX, scaleY)));
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
    this.ctx.imageSmoothingEnabled = false;
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
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const sector = getSectorForTile(col, row);
        if (!sector) continue;
        const arrangementId = getTileAt(col, row);
        const screenX = col * TILE_SIZE - camX;
        const screenY = row * TILE_SIZE - camY;
        if (isComposite(arrangementId)) {
          drawComposite(this.ctx, arrangementId, screenX, screenY);
        } else {
          drawTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, screenX, screenY);
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
    const drawFG = camera.zoom >= FG_PASS_MIN_ZOOM;

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
      downed = false
    ) => {
      // Downed = KO'd: rotate the whole sprite 90° around its mid so it lays on
      // its back. Each FG-priority part rotates around the SAME pivot, so the
      // slices still compose into one coherent rotated body.
      if (downed) {
        const h = getSpriteGroupMeta(groupId)?.height ?? DEFAULT_SPRITE_H;
        const px = sx;
        const py = sy - h / 2;
        this.ctx.save();
        this.ctx.translate(px, py);
        this.ctx.rotate(Math.PI / 2);
        this.ctx.translate(-px, -py);
      }
      const itemHere = itemId !== null && part !== 'upper';
      if (itemHere && isItemBehind(direction)) {
        drawHeldItem(this.ctx, itemId!, direction, frame, pose, sx, sy);
      }
      drawSprite(this.ctx, groupId, direction, frame, sx, sy, part, pose, flash);
      if (itemHere && !isItemBehind(direction)) {
        drawHeldItem(this.ctx, itemId!, direction, frame, pose, sx, sy);
      }
      if (downed) this.ctx.restore();
    };

    const playerSx = Math.round(player.x) - camX;
    const playerSy = Math.round(player.y) - camY;
    addSprite(
      player.x,
      player.y,
      (part) =>
        drawEntityPart(
          player.spriteGroupId,
          player.direction,
          player.frame,
          player.pose,
          player.heldItemId,
          playerSx,
          playerSy,
          part,
          player.flashUntil > now,
          player.downed
        ),
      () => {
        // Downed: show the revive countdown over the body instead of bars.
        if (player.downed) {
          drawDownedCountdown(
            this.ctx,
            playerSx,
            playerSy,
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
        drawHealthBar(
          this.ctx,
          playerSx,
          playerSy,
          player.spriteGroupId,
          player.healthRatio,
          ppRatio
        );
        drawNameplate(
          this.ctx,
          playerSx,
          playerSy,
          player.spriteGroupId,
          s.name,
          s.level,
          true,
          player.pk
        );
        drawStatusPips(this.ctx, playerSx, playerSy, player.spriteGroupId, true, player.statuses);
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
        (part) =>
          drawEntityPart(
            rp.spriteGroupId,
            rp.direction,
            rp.frame,
            rp.pose ?? 'walk',
            rp.itemId ?? null,
            rpScreenX,
            rpScreenY,
            part,
            (rp.flashUntil ?? 0) > now,
            !!rp.downed
          ),
        () => {
          // Downed ally: show their revive countdown so others know to hurry.
          if (rp.downed) {
            drawDownedCountdown(
              this.ctx,
              rpScreenX,
              rpScreenY,
              rp.spriteGroupId,
              rp.downedUntil ?? now,
              now
            );
            return;
          }
          // Other players: an HP bar (no PSI — that's private) with their
          // name + level above it, so everyone can read who's who and how strong.
          const ratio = rp.maxHp ? Math.max(0, Math.min(1, (rp.hp ?? rp.maxHp) / rp.maxHp)) : 1;
          drawHealthBar(this.ctx, rpScreenX, rpScreenY, rp.spriteGroupId, ratio);
          drawNameplate(
            this.ctx,
            rpScreenX,
            rpScreenY,
            rp.spriteGroupId,
            rp.name,
            rp.level ?? 1,
            false,
            rp.pk ?? false
          );
          drawStatusPips(this.ctx, rpScreenX, rpScreenY, rp.spriteGroupId, false, rp.statuses);
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
                drawHealthBar(this.ctx, nScreenX, nScreenY, npc.spriteGroupId, npc.healthRatio);
              drawStatusPips(this.ctx, nScreenX, nScreenY, npc.spriteGroupId, false, npc.statuses);
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

    // The FG layer over the BG for areas with NO sprite (sprites re-cover their
    // own footprint below). Native foreground tiles are transparent except their
    // FG pixels; "Behind"/0x40 tiles are already in the BG pass, so they're only
    // re-drawn per-sprite to occlude a hidden sprite — not here.
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

    // "See-through while hiding": when the LOCAL player is behind a building, a
    // soft CIRCLE of reveal ghosts the Behind/0x40 redraw so you can see yourself
    // and anyone else tucked behind the same building. Radial falloff keeps the
    // edge soft; the rest of the building stays solid.
    const REVEAL_IN = 52; // fully ghosted within this radius (world px)
    const REVEAL_OUT = 108; // back to fully solid past this radius
    const MIN_ALPHA = 0.1; // building opacity at the centre of the reveal (~10%)
    const playerHidden = getSpritePriority(player.x, player.y) !== 0;

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
          if (isComposite(arrangementId)) {
            // Composites just re-cover their FG over the sprite; no behind/reveal.
            drawCompositeFg(this.ctx, arrangementId, sx, sy);
            continue;
          }
          if (hasForegroundTile(sector.tilesetId, sector.paletteId)) {
            drawForegroundTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, sx, sy);
          }
          const mask = getPromotedMinitiles(col, row);
          if (mask.length === 0) continue;
          let alpha = 1;
          if (playerHidden) {
            const dx = col * TILE_SIZE + TILE_SIZE / 2 - player.x;
            const dy = row * TILE_SIZE + TILE_SIZE / 2 - player.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d <= REVEAL_IN) alpha = MIN_ALPHA;
            else if (d < REVEAL_OUT)
              alpha = MIN_ALPHA + (1 - MIN_ALPHA) * ((d - REVEAL_IN) / (REVEAL_OUT - REVEAL_IN));
          }
          // Clip to just the painted minitiles, then draw the tile art — only the
          // Behind cells show through, giving sub-tile (8px) hide precision.
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
          if (alpha < 1) this.ctx.globalAlpha = alpha;
          drawTile(this.ctx, sector.tilesetId, sector.paletteId, arrangementId, sx, sy);
          if (alpha < 1) this.ctx.globalAlpha = 1;
          this.ctx.restore();
        }
      }
    };

    // Feet-Y order; the local player wins ties so you're never hidden under an
    // NPC you're standing level with.
    jobs.sort((a, b) => a.feetY - b.feetY || (a.local ? 1 : 0) - (b.local ? 1 : 0));
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
        // In front of the FG layer — drawn over the global FG pass above.
        job.drawPart('full');
        job.drawBar?.();
      }
    }

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
    drawBuffHud(this.ctx, player.buffs, now);

    // Downed: closing vignette + give-up prompt (owner only), over everything.
    if (player.downed) {
      const h = getSpriteGroupMeta(player.spriteGroupId)?.height ?? DEFAULT_SPRITE_H;
      const cx = Math.round(player.x) - camX;
      const cy = Math.round(player.y) - camY - h / 2;
      const total = player.downedTotalMs || 30000;
      const t = 1 - Math.max(0, Math.min(1, (player.downedUntil - now) / total));
      drawDownedVignette(this.ctx, cx, cy, t);
      drawGiveUpPrompt(this.ctx, player.giveUpProgress);
    }
  }

  /**
   * Draw the collision/priority overlay live over the world (editor header
   * "Collision" toggle). Mirrors CollisionTool.drawOverlay exactly — same
   * getEffectiveRowAt source and colors — so what you see in-game matches the
   * Priority Painter and the collision system: red = solid (0x80), blue = pri-lo
   * (0x01), purple = pri-hi (0x02), yellow = FG-promote/hide (0x40).
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
