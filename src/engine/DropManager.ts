/**
 * DropManager — ground loot lying in the world (server-authoritative).
 *
 * The server owns every drop: it spawns them where an enemy died (items) or a
 * player died (money), decides who claims one (first-touch), and tells us to add
 * or remove them. We just mirror that set and paint it. Pickup is NOT client-side
 * — walking onto a drop is detected server-side; we only render until the server
 * says it's gone. See server/npcSim.js (drop_spawn / drop_remove) + LOOT_AND_BANKING.md.
 *
 * Drawn in WORLD space (the Renderer calls renderDrops after the tile pass), so
 * drops sit on the ground beneath sprites and share the camera transform.
 */
import { drawItemIcon } from './Items';

export interface GroundDrop {
  id: string;
  kind: 'item' | 'money';
  x: number; // world LANDING anchor (feet)
  y: number;
  item?: number; // item drops: catalog id
  name?: string;
  amount?: number; // money drops: cash value
  sprite?: string; // money drops: item id to render as (death cash → c001); else a coin
  // Ejection: present only while a fresh drop is still flying out of the corpse.
  // The drop arcs from (fromX,fromY) to its contact point over ejectMs, then rests.
  fromX?: number;
  fromY?: number;
  ejectMs?: number;
  // Wall landing: the item first contacted a wall at this Y, then fell straight
  // down to the resting `y`. Present only while the fall is still animating.
  fallFromY?: number;
}

// Stored drop carries a client birth time so we can animate the eject arc.
type LiveDrop = GroundDrop & { bornAt: number };

const ITEM_SIZE = 16; // px the held-item icon is drawn at on the ground
const EJECT_HEIGHT = 18; // px peak hop height of the ejection arc
const FALL_PX_PER_MS = 0.18; // speed a wall-landed drop falls to the ground (mirrored: npcSim.js)

const drops = new Map<string, LiveDrop>();

/** Replace the whole set (welcome snapshot / re-join). Already at rest. */
export function setDrops(list: GroundDrop[]): void {
  drops.clear();
  for (const d of list) if (d && d.id) drops.set(d.id, { ...d, bornAt: 0 });
}
/** A new drop appeared — animate it if the server sent eject and/or fall info. */
export function addDrop(d: GroundDrop): void {
  if (d && d.id)
    drops.set(d.id, {
      ...d,
      bornAt: d.fromX != null || d.fallFromY != null ? performance.now() : 0,
    });
}
/** A drop was claimed/removed. */
export function removeDrop(id: string): void {
  drops.delete(id);
}
/** Wipe all drops (e.g. disconnect). */
export function clearDrops(): void {
  drops.clear();
}

/**
 * Paint every drop. `camX`/`camY` are the Renderer's shared integer camera
 * origin (the same one tiles/sprites use), so a drop lands exactly on its tile.
 */
export function renderDrops(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
  const now = performance.now();
  for (const d of drops.values()) {
    // Resolve the current ground anchor (where the shadow sits) + hop height above
    // it. Two optional phases play back-to-back from bornAt:
    //   1. eject  — arc from (fromX,fromY) up to the contact point (x, contactY)
    //   2. fall   — drop straight down from contactY to the resting y (wall landing)
    // contactY is fallFromY when the item hit a wall, else just the resting y. Once
    // both phases finish (or there's no anim info) it rests at (x,y) with no hop.
    let gx = d.x;
    let gy = d.y; // ground anchor the shadow tracks
    let hop = 0; // icon height above that anchor
    if (d.bornAt) {
      const t0 = now - d.bornAt;
      const ejectMs = d.fromX != null && d.fromY != null ? d.ejectMs || 0 : 0;
      const contactY = d.fallFromY != null ? d.fallFromY : d.y;
      const fallDist = d.y - contactY; // >= 0
      const fallMs = fallDist > 0 ? fallDist / FALL_PX_PER_MS : 0;
      if (ejectMs > 0 && t0 < ejectMs) {
        // Phase 1: arc out to the contact point.
        const t = t0 / ejectMs;
        gx = d.fromX! + (d.x - d.fromX!) * t;
        gy = d.fromY! + (contactY - d.fromY!) * t; // shadow rides the arc
        hop = Math.sin(t * Math.PI) * EJECT_HEIGHT;
      } else if (fallDist > 0 && t0 < ejectMs + fallMs) {
        // Phase 2: shadow snaps to the real landing; icon falls straight down to it.
        const tf = (t0 - ejectMs) / fallMs; // 0 → contact, 1 → resting
        gx = d.x;
        gy = d.y;
        hop = fallDist * (1 - tf);
      }
    }
    const sx = Math.round(gx - camX);
    const groundY = Math.round(gy - camY);
    const sy = groundY - Math.round(hop);

    const isCash = d.kind === 'money';

    // Non-cash item drops: soft ellipse shadow on the ground while airborne, so
    // the eject arc reads as height. Cash gets its own silhouette shadow below.
    if (!isCash && hop > 0.5) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(sx, groundY - 1, 4, 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Money drops render as the cash item art (c001); item drops as their own
    // held art. Center the icon on the anchor, resting just above the feet; a
    // sprite with no loaded art falls back to a small sparkle so it's still visible.
    const spriteId = isCash ? d.sprite : d.item != null ? String(d.item) : null;
    let ok = false;
    if (spriteId != null) {
      if (isCash) {
        // Each scattered cash object sits at its own tilt so a pile reads as a
        // jumble, not a stack of identical icons. Rotate about the icon's center.
        const angle = rotFor(d.id);
        const cx = sx;
        const cy = sy - ITEM_SIZE / 2;
        // Drop shadow: a black silhouette of the cash, same tilt, nudged down-right
        // a few px in screen space so it reads as the bill casting onto the ground.
        const sil = silhouette(spriteId);
        if (sil) {
          ctx.save();
          ctx.globalAlpha = 0.35;
          ctx.translate(cx + SHADOW_DX, cy + SHADOW_DY);
          ctx.rotate(angle);
          ctx.drawImage(sil, -ITEM_SIZE / 2, -ITEM_SIZE / 2, ITEM_SIZE, ITEM_SIZE);
          ctx.restore();
        }
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ok = drawItemIcon(ctx, spriteId, -ITEM_SIZE / 2, -ITEM_SIZE / 2, ITEM_SIZE);
        ctx.restore();
      } else {
        ok = drawItemIcon(ctx, spriteId, sx - ITEM_SIZE / 2, sy - ITEM_SIZE, ITEM_SIZE);
      }
    }
    if (!ok) drawSparkle(ctx, sx, sy - ITEM_SIZE / 2);
  }
}

// A stable per-drop tilt (radians) so every scattered cash object lands at its
// own angle. Derived from the drop id, so it's identical for all viewers and
// across rejoins, and never flickers frame-to-frame. ±~46°.
const CASH_MAX_TILT = 0.8;
function rotFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const u = ((h >>> 0) % 1000) / 1000; // [0,1)
  return (u - 0.5) * 2 * CASH_MAX_TILT;
}

// Screen-space offset of the cash drop shadow (down-right, a few px).
const SHADOW_DX = 2;
const SHADOW_DY = 2.5;

// A black silhouette of an item's art, cached per id (built once the art loads).
// Used as the cash drop shadow — same shape as the bill, drawn tinted + offset.
const silCache = new Map<string, HTMLCanvasElement>();
function silhouette(id: string): HTMLCanvasElement | null {
  const cached = silCache.get(id);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = ITEM_SIZE;
  const sctx = c.getContext('2d')!;
  if (!drawItemIcon(sctx, id, 0, 0, ITEM_SIZE)) return null; // art not loaded yet — retry next frame
  sctx.globalCompositeOperation = 'source-atop'; // tint only the opaque pixels black
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, ITEM_SIZE, ITEM_SIZE);
  silCache.set(id, c);
  return c;
}

// Fallback marker for a drop whose art hasn't loaded — a tiny diamond glint.
function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#fff6c0';
  ctx.beginPath();
  ctx.moveTo(0, -5);
  ctx.lineTo(3, 0);
  ctx.lineTo(0, 5);
  ctx.lineTo(-3, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
