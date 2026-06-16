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
  // Ejection: present only while a fresh drop is still flying out of the corpse.
  // The drop arcs from (fromX,fromY) to (x,y) over ejectMs, then rests.
  fromX?: number;
  fromY?: number;
  ejectMs?: number;
}

// Stored drop carries a client birth time so we can animate the eject arc.
type LiveDrop = GroundDrop & { bornAt: number };

const ITEM_SIZE = 16; // px the held-item icon is drawn at on the ground
const EJECT_HEIGHT = 18; // px peak hop height of the ejection arc

const drops = new Map<string, LiveDrop>();

/** Replace the whole set (welcome snapshot / re-join). Already at rest. */
export function setDrops(list: GroundDrop[]): void {
  drops.clear();
  for (const d of list) if (d && d.id) drops.set(d.id, { ...d, bornAt: 0 });
}
/** A new drop appeared — eject-animate it if the server sent flight info. */
export function addDrop(d: GroundDrop): void {
  if (d && d.id) drops.set(d.id, { ...d, bornAt: d.fromX != null ? performance.now() : 0 });
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
    // Resolve the current ground position + hop height. While ejecting, the drop
    // lerps from origin to landing and arcs up (sin) then back down; once landed
    // (t>=1, or no flight info) it rests at (x,y) with no hop.
    let gx = d.x;
    let gy = d.y;
    let hop = 0;
    if (d.bornAt && d.fromX != null && d.fromY != null && d.ejectMs) {
      const t = Math.min(1, (now - d.bornAt) / d.ejectMs);
      gx = d.fromX + (d.x - d.fromX) * t;
      gy = d.fromY + (d.y - d.fromY) * t;
      hop = Math.sin(t * Math.PI) * EJECT_HEIGHT;
    }
    const sx = Math.round(gx - camX);
    const groundY = Math.round(gy - camY);
    const sy = groundY - Math.round(hop);

    // Soft shadow on the ground while airborne, so the arc reads as height.
    if (hop > 0.5) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(sx, groundY - 1, 4, 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (d.kind === 'money') {
      drawCoin(ctx, sx, sy);
    } else {
      // Center the icon on the anchor, resting just above the feet. Items with no
      // authored held art fall back to a small sparkle so the drop is still visible.
      const ok =
        d.item != null &&
        drawItemIcon(ctx, String(d.item), sx - ITEM_SIZE / 2, sy - ITEM_SIZE, ITEM_SIZE);
      if (!ok) drawSparkle(ctx, sx, sy - ITEM_SIZE / 2);
    }
  }
}

// A small gold coin for money drops (no ROM art for cash — drawn from primitives).
function drawCoin(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y - 5);
  ctx.fillStyle = '#caa21a';
  ctx.beginPath();
  ctx.ellipse(0, 0, 5, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffe14d';
  ctx.beginPath();
  ctx.ellipse(-1, -1, 3, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8a6d00';
  ctx.fillRect(-1, -3, 2, 6);
  ctx.restore();
}

// Fallback marker for an item with no held sprite — a tiny diamond glint.
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
