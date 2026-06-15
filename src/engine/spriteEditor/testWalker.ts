// LIVE TEST pane: a WASD-driven walker rendered through the real game sprite
// path, plus ladder/rope climb props and the item-positioning drag. Lets the
// admin see attack/hurt/climb/peace/laying poses and held items animate exactly
// as they will in-world.
import { drawSprite, getLiveSheet } from '../SpriteManager';
import {
  drawHeldItem,
  isItemBehind,
  isItemFlipped,
  getItemName,
  offsetFor,
  setItemOffset,
  defaultHeldOffset,
} from '../Items';
import {
  FRAME_W,
  FRAME_H,
  CLIMB_ROW,
  LAYING_ROW,
  TEST_W,
  TEST_H,
  TEST_SCALE,
  LADDER_X,
  ROPE_X,
  CLIMB_TOP,
  CLIMB_BOT,
  DIR_FROM_DELTA,
  clamp,
} from './constants';
import { S } from './state';
import { persistItem } from './itemEditor';

export function updateWalker(): void {
  // Attack/hurt previews play out like in-game: brief, movement-locked.
  if (S.walkerPose === 'attack') {
    S.walkerPoseTimer++;
    // 3 weapon frames (wind-up/swing/follow-through), matching Player timing.
    S.walkerFrame = S.walkerPoseTimer < 6 ? 0 : S.walkerPoseTimer < 11 ? 1 : 2;
    if (S.walkerPoseTimer >= 16) {
      S.walkerPose = 'walk';
      S.walkerFrame = 0;
    }
    return;
  }
  if (S.walkerPose === 'hurt') {
    S.walkerPoseTimer++;
    S.walkerFrame = S.walkerPoseTimer < 8 ? 0 : 1; // recoil then settle
    if (S.walkerPoseTimer >= 20) {
      S.walkerPose = 'walk';
      S.walkerFrame = 0;
    }
    return;
  }
  // Peace/laying: single static frame held until you move (no animation).
  if (S.walkerPose === 'peace' || S.walkerPose === 'laying') {
    S.walkerFrame = 0;
    if (S.heldKeys.has('w') || S.heldKeys.has('a') || S.heldKeys.has('s') || S.heldKeys.has('d')) {
      S.walkerPose = 'walk';
    }
    return;
  }

  const dx = (S.heldKeys.has('d') ? 1 : 0) - (S.heldKeys.has('a') ? 1 : 0);
  const dy = (S.heldKeys.has('s') ? 1 : 0) - (S.heldKeys.has('w') ? 1 : 0);
  if (dx === 0 && dy === 0) {
    S.walkerFrame = 0;
    S.walkerTimer = 0;
  } else {
    S.walkerDir = DIR_FROM_DELTA[`${dx},${dy}`];
    const speed = dx !== 0 && dy !== 0 ? 1.06 : 1.5; // EB-style diagonal slowdown
    S.walkerX = clamp(S.walkerX + dx * speed, FRAME_W / 2, TEST_W - FRAME_W / 2);
    S.walkerY = clamp(S.walkerY + dy * speed, FRAME_H + 2, TEST_H - 2);
    if (++S.walkerTimer >= 8) {
      S.walkerTimer = 0;
      S.walkerFrame = S.walkerFrame === 0 ? 1 : 0;
    }
  }
  // On a ladder/rope prop -> show climb frames (animates while moving).
  S.walkerClimb = climbZoneAt(S.walkerX, S.walkerY);
}

/** Which climb prop (if any) the test walker is standing on. */
function climbZoneAt(x: number, y: number): 'ladder' | 'rope' | null {
  if (y < CLIMB_TOP - 6 || y > CLIMB_BOT + 6) return null;
  if (Math.abs(x - LADDER_X) <= 8) return 'ladder';
  if (Math.abs(x - ROPE_X) <= 7) return 'rope';
  return null;
}

export function drawTestPane(): void {
  const ctx = S.testCanvas.getContext('2d')!;
  ctx.setTransform(TEST_SCALE, 0, 0, TEST_SCALE, 0, 0);
  ctx.imageSmoothingEnabled = false;

  // Simple grass checker so motion is visible.
  ctx.fillStyle = '#3a6a44';
  ctx.fillRect(0, 0, TEST_W, TEST_H);
  ctx.fillStyle = '#35613e';
  for (let ty = 0; ty < TEST_H; ty += 16) {
    for (let tx = (ty / 16) % 2 === 0 ? 0 : 16; tx < TEST_W; tx += 32) {
      ctx.fillRect(tx, ty, 16, 16);
    }
  }

  drawClimbProps(ctx);

  // On a climb prop: show the matching climb frame (ladder cols 0/1, rope 2/3).
  if (S.walkerClimb) {
    drawClimbCell(ctx, (S.walkerClimb === 'ladder' ? 0 : 2) + S.walkerFrame, S.walkerX, S.walkerY);
    return;
  }
  // Laying is a wide+tall single sprite — blit the whole figure so it isn't cropped.
  if (S.walkerPose === 'laying') {
    drawLayingCell(ctx, S.walkerX, S.walkerY);
    return;
  }

  // Same overlay ordering as the in-game renderer: far-hand items go under
  // the body, near-hand items on top.
  const itemBehind = S.walkerItem !== null && isItemBehind(S.walkerDir);
  if (S.walkerItem && itemBehind) {
    drawHeldItem(ctx, S.walkerItem, S.walkerDir, S.walkerFrame, S.walkerPose, S.walkerX, S.walkerY);
  }
  drawSprite(
    ctx,
    S.groupId,
    S.walkerDir,
    S.walkerFrame,
    S.walkerX,
    S.walkerY,
    'full',
    S.walkerPose
  );
  if (S.walkerItem && !itemBehind) {
    drawHeldItem(ctx, S.walkerItem, S.walkerDir, S.walkerFrame, S.walkerPose, S.walkerX, S.walkerY);
  }
}

/** Draw the ladder + rope props the walker can climb on, with labels. */
function drawClimbProps(ctx: CanvasRenderingContext2D): void {
  // Ladder: two rails + rungs.
  ctx.fillStyle = '#9a6526';
  ctx.fillRect(LADDER_X - 7, CLIMB_TOP, 2, CLIMB_BOT - CLIMB_TOP);
  ctx.fillRect(LADDER_X + 5, CLIMB_TOP, 2, CLIMB_BOT - CLIMB_TOP);
  ctx.fillStyle = '#c08a3e';
  for (let ry = CLIMB_TOP + 3; ry < CLIMB_BOT; ry += 7) ctx.fillRect(LADDER_X - 7, ry, 14, 2);
  // Rope: a thin wavy line with knots.
  ctx.fillStyle = '#caa86a';
  ctx.fillRect(ROPE_X - 1, CLIMB_TOP, 2, CLIMB_BOT - CLIMB_TOP);
  ctx.fillStyle = '#9c7c44';
  for (let ry = CLIMB_TOP + 4; ry < CLIMB_BOT; ry += 9) ctx.fillRect(ROPE_X - 2, ry, 4, 2);
  // Labels.
  ctx.fillStyle = '#000';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('ladder', LADDER_X, CLIMB_TOP - 3);
  ctx.fillText('rope', ROPE_X, CLIMB_TOP - 3);
}

/** Blit one climb cell (row 4, given col) of the live sheet at the walker spot,
 *  using the same foot-anchor as drawSprite. */
function drawClimbCell(ctx: CanvasRenderingContext2D, col: number, x: number, y: number): void {
  const live = getLiveSheet(S.groupId);
  if (!live) return;
  ctx.drawImage(
    live,
    col * FRAME_W,
    CLIMB_ROW * FRAME_H,
    FRAME_W,
    FRAME_H,
    Math.floor(x - FRAME_W / 2),
    Math.floor(y - FRAME_H - 1),
    FRAME_W,
    FRAME_H
  );
}

/** Blit the single laying sprite: one 3x2-block (24x16) figure stored at row 14,
 *  cols 0-1, bottom-anchored near the walker's feet. */
function drawLayingCell(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const live = getLiveSheet(S.groupId);
  if (!live) return;
  const lw = 24;
  const lh = 16;
  ctx.drawImage(
    live,
    0,
    LAYING_ROW * FRAME_H,
    lw,
    lh,
    Math.floor(x - lw / 2),
    Math.floor(y - lh - 1),
    lw,
    lh
  );
}

// --- Live-test item positioning ------------------------------------------------
// In Item mode, drag the held item on the character to set its body-mount offset.
// First drag lifts it off the hand; releasing persists. Weapons stay hand-held
// until dragged; "Hand-held (reset)" clears the offset.

/** Pointer in test-pane LOGICAL pixels (the space the walker lives in). */
function testLogical(e: MouseEvent): { lx: number; ly: number } {
  const r = S.testCanvas.getBoundingClientRect();
  return { lx: (e.clientX - r.left) / TEST_SCALE, ly: (e.clientY - r.top) / TEST_SCALE };
}

export function onTestDown(e: MouseEvent): void {
  const { lx, ly } = testLogical(e);
  S.testPointer = {
    startLX: lx,
    startLY: ly,
    lastLX: lx,
    lastLY: ly,
    moved: false,
    canDragItem: S.editMode === 'item' && !!S.walkerItem && S.walkerItem === S.itemEditId,
  };
  e.preventDefault();
}

export function onTestMove(e: MouseEvent): void {
  if (!S.testPointer) return;
  const { lx, ly } = testLogical(e);
  if (
    !S.testPointer.moved &&
    Math.hypot(lx - S.testPointer.startLX, ly - S.testPointer.startLY) > 1.5
  ) {
    S.testPointer.moved = true; // a real drag, not a click
  }
  if (S.testPointer.moved && S.testPointer.canDragItem && S.walkerItem) {
    // First drag motion lifts a hand-held item off the hand so it moves smoothly.
    if (!offsetFor(S.walkerItem)) setItemOffset(S.walkerItem, defaultHeldOffset(S.walkerDir));
    const off = offsetFor(S.walkerItem);
    if (off) {
      // Offsets store in canonical (right-facing) space; a flipped facing draws
      // mirrored, so a rightward screen drag moves canonical x the other way.
      const dxs = isItemFlipped(S.walkerDir) ? -1 : 1;
      setItemOffset(S.walkerItem, {
        x: Math.round(off.x + dxs * (lx - S.testPointer.lastLX)),
        y: Math.round(off.y + (ly - S.testPointer.lastLY)),
      });
    }
  }
  S.testPointer.lastLX = lx;
  S.testPointer.lastLY = ly;
}

/** Start the attack preview on the test character (same as pressing F). */
export function triggerTestAttack(): void {
  if (S.walkerPose === 'walk') {
    S.walkerPose = 'attack';
    S.walkerPoseTimer = 0;
  }
}

/** Global mouseup while a test-pane pointer is active: persist an item drag, or
 *  fire an attack on a click. Returns true if it handled the event. */
export function finishTestPointer(): boolean {
  if (!S.testPointer) return false;
  const p = S.testPointer;
  S.testPointer = null;
  if (p.moved && p.canDragItem) {
    persistItem(); // a real drag — write the new body-mount offset to the file
    const o = offsetFor(S.itemEditId);
    if (S.itemNote && o) {
      S.itemNote.textContent = `${getItemName(S.itemEditId) ?? S.itemEditId} — positioned at (${o.x},${o.y})`;
    }
  } else if (!p.moved) {
    triggerTestAttack(); // a click on the character — attack and play the anim
  }
  return true;
}
