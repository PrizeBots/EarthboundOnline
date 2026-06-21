# Bug Log

Known bugs and their status. Add new entries at the top. When a bug is fixed,
move it to the Fixed section with a note on the root cause and the fix — the
history is the documentation (several of these systems have failed the same
way more than once).

Format:

```
## <short title>            (OPEN | FIXED <date>)
- **Symptom:** what the player sees, where to reproduce
- **Root cause:** (once known)
- **Fix:** what changed, how it was verified
```

---

## Open

## Fixed

### Escalator ride overshoots the landing / can't get off (FIXED 2026-06-20)

- **Symptom:** dept-store escalators (Twoson/Fourside) — the UP ride doesn't stop
  at the top (keeps auto-walking past it), the DOWN ride won't let you off at the
  bottom. "Super messed up."
- **Root cause:** the ride stopped on "the minitile ahead along the ramp is SOLID."
  But these are short, SAME-FLOOR stairway pairs (ROM door type 4) whose landing is
  OPEN dept-store floor, not a wall — so the solid test never fired and the ride ran
  to the 256px runaway cap, overshooting the landing (and dumping you onto the paired
  trigger / into walls).
- **Fix:** use the ROM's own pairing. Every directional stairway/escalator trigger
  has a PARTNER trigger along its diagonal (verified: all 82 pair, distances 2–31
  minitiles). `DoorManager.getStairLanding` marches the diagonal and returns that
  paired trigger; `Game.updateRide` stops the glide exactly there (snaps onto it).
  The old solid-ahead / runaway-cap stop stays as a fallback. Floor-changing rides
  still warp via `getStairExit` on arrival.
- **Follow-up (same-floor crop — "scene went black, stuck at top"):** the dept-store
  stairways HOP 2–8 tiles within ONE room (start and landing share the same room
  flood). The ride was still running the stacked-floor crop machinery
  (`computeRideBounds` union at start, `updateRoomBounds` re-crop at the landing) on
  them — and the re-crop's pocket-merge/door-reject logic could return a degenerate
  region, blacking out the scene and sealing the player. Fix: detect `sameFloor` at
  ride start (landing tile already inside the current room crop) and then NEVER touch
  the camera crop for that ride. Only a TRUE floor change (landing in a different
  region) gets the union + re-crop. Matches the symptom timing exactly (glide fine,
  black only on arrival).
- **Verified:** typecheck clean; ROM pairing audit 82/82; dept-store flood is one
  shared room (start==landing==1526 mt). Needs an in-game ride check.
- **Follow-up 2 (Twoson overshoot — "fly across the room into the wall"):** Twoson's
  dept store (combo 20_1, drawTS 12) has LONG escalators (152px / 19 mt) whose ramp
  is 100% WALKABLE (not solid steps). The solid-ahead fallback can never fire on a
  walkable ramp, and the pure distance-to-precomputed-landing check could skim past
  the trigger box → ran to the 256px cap. Fix: `updateRide` now stops using
  `getStairAt` DURING the ride — the exact detector that STARTS a ride — armed once
  we've glided clear of the start trigger (`leftStart`). If a ride can start on a
  trigger it now reliably stops on its partner, regardless of ramp length/solidity.
  Distance + solid + cap remain as fallbacks.
- **Follow-up 3 (stuck at the top after the ride):** the server `ride_warp` raised
  the warp shield (`entry.warping`, 8s). For a door warp the fade clears it, but an
  open escalator ride has no fade — so it stayed up, and `_simPlayers` HOLDS a
  warping player (ignores inputs), freezing the rider at the landing for 8s. Fix:
  `ride_warp` no longer raises the shield (position is set directly — no speed-clamp
  to dodge — and the client is immediately live). Door-exit rides still fade+shield
  via their own `warp` message.

### Escalator STEP animation is tile-graphic (OPEN — pipeline built, frame SOURCE wrong)

- **Finding:** the escalator STEPS animate via EB's _Tile Animation Properties Table_
  (ROM 0x2F126B unheadered; swaps minitile GRAPHICS in VRAM — escalators/conveyors/
  waterfalls), NOT palette cycling. Table parsed OK (`tools/tile_anim.py`): Twoson
  drawTS 12 = 3f delay 5; Fourside drawTS 13 = 8f delay 3.
- **WRONG ASSUMPTION (caused "flashing with the wrong sprites"):** I assumed the per-
  frame graphics were consecutive tileset minitiles (M, M+stride, ...). They are NOT —
  the graphics block is exactly 896 minitiles with nothing appended; EB decompresses a
  SEPARATE per-tileset animation-graphics asset to $7EC000. Using tileset minitiles
  swapped in unrelated tiles in-game. **Disabled** (`ESCALATOR_DRAW_TS = set()`) so
  escalators are static, not garbled.
- **What's left (TODO2.md):** locate the per-tileset animation-graphics source (the
  $7EC000 asset) + its ROM pointer, decode its minitiles, then the `tile_anim.py` frame
  remap points at THOSE. The bake/manifest/`TilesetManager` path already works (the
  palette system uses it); only the frame source is missing.

### Escalator ride — stuck at the top (room-seal seam) (FIXED 2026-06-21)

- **Symptom:** after the ride STOPS at the top you can't move ("stuck on top").
- **Root cause (client seal):** the ride snaps the player exactly onto the landing
  trigger, which sits at the ramp/floor boundary. After `updateRoomBounds` re-seals to
  the destination room, the player's foot box straddles OUTSIDE the sealed cells, so
  `checkPlayerCollision` blocks every direction. (A server warp-shield freeze — see
  ride Follow-up 3 — was a separate contributor, already removed.)
- **Fix:** `Game.nudgeIntoRoom` — after the ride, if the foot box collides, nudge to
  the nearest free spot (ride direction first = deeper onto the floor), mirroring the
  door-warp nudge; respects walls AND the room seal. Runs before `sendRideWarp` so the
  server gets the freed position.

### Escalators never stop — ride loops, server drags you back (FIXED 2026-06-20)

- **Symptom:** Twoson dept-store escalator: stepping on it the player is moved
  endlessly and never settles on the next floor (rides up, snaps back, repeats);
  the player also looks stuck/jittery rather than gliding smoothly.
- **Root cause:** the server-authoritative movement switch (commit `be483a1`).
  The escalator ride glides the player diagonally **client-side only**
  (`Player.rideStep`, bypasses collision); it sends no inputs, so the server's
  authoritative position stays at the escalator's foot. Its stale `pos` ACKs then
  `reconcile()` the client back down — and after a door-exit warp the next input
  resimulates from the foot and yanks the player off the new floor. Net: an
  endless tug-of-war, so the ride never reaches its `aheadSolid` stop.
- **Fix:** make the escalator a _trusted, server-aware_ movement (same trust
  model as `move`/knockback, gated so you can't warp anywhere):
  1. `Player.riding` suppresses `reconcile()` for the duration of the glide.
  2. At ride end the client sends `ride_warp {x,y}` (the landing, or the floor
     door's dest); `Game.updateRide` calls it before the transition / re-crop.
  3. Server `ride_warp` (gameHost) honors it ONLY when the player's authoritative
     position is on an escalator (`npcSim.stairAt`, new — mirrors DoorManager's
     stair load), then resyncs there + raises the warp shield. It does **not**
     echo a `warp` (the client owns the visual, so the dest isn't revealed before
     the fade).
- **Escalator step animation (built 2026-06-20):** EB animates the dept-store
  escalator steps (and water/lava/…) via palette cycling — the "Flash Effect"
  system. Now extracted from ROM and rendered: `tools/palette_anim.py` +
  per-frame atlases + `atlases/anim.json`, swapped on a clock in `TilesetManager`
  (see ARCHITECTURE.md "Animated tiles"). The escalators are combo `29_3` (8
  frames); the other 84 stair triggers are plain stairs EB never animated.
- **Verified:** typecheck clean; server tests unchanged (53 pass / 7 pre-existing
  shop-catalog fails, identical before/after). Needs an in-game ride check.

### NPCs don't respect room seals (OPEN, minor)

- **Symptom (theoretical):** server-side NPC wander (`server/npcSim.js`) uses
  plain collision, so an NPC near a room edge could wander onto the shared
  under-wall strip into a neighboring room (where the local player now sees
  a black void). Wander radii are small, so this may never visibly happen.
- **Fix idea:** mirror the room-cell constraint in npcSim, or clamp wander
  to the NPC's home room mask.

### Indoor room with large walkable spill to outdoor filler (OPEN, minor)

- **Symptom:** The interior at dest px (5480, 6864) (sector 21,53, tileset 21) has a 21-minitile walkable seam into non-croppable sectors — wider
  than a normal door threshold. The flood correctly stops there, so up to
  21 walkable minitiles at the room edge render black. Pre-existing
  (mask identical before/after the dungeon-crop fix); needs a visual check
  to see whether anything looks cut off in practice.

### Free enemy hits on the player during a door transition (FIXED 2026-06-14)

- **Symptom:** Taking a door with an enemy on your tail, you lose HP during the
  fade — you can't move or defend while the screen is black.
- **Root cause:** The client freezes its reported position for the whole door
  fade (`Game.update` early-returns while `transitioning`, suppressing
  `sendPosition`). The server keeps simulating, so the pursuer reaches the
  doorway and swings at the motionless "ghost" left at the player's last sent
  position; each swing applied real damage.
- **Fix:** A door-transition damage shield. The client sends `{type:'warp',
warping}` on transition start/end (`Network.sendWarpState`, wired in
  `Game.startTransition` / `updateTransition`); `GameHost` marks the player
  `warping` and `damagePlayer` ignores hits while it's set. Cleared by the
  `warp` end signal OR the next `move` (fallback), with an 8s `warpUntil`
  backstop against a dropped end signal. The player stays in the sim's target
  list so the enemy keeps chasing (and the door-follow above still fires) — only
  the damage whiffs. Covered by 3 new cases in `gameHost.test.js`.
- **Verified:** `npm run verify` green (25 server tests incl. the new shield
  cases).

### Enemies only sometimes pursue a player through a door (FIXED 2026-06-14)

- **Symptom:** A player "hot on their tail" can sometimes lure an enemy into a
  room through a door, but it's unreliable — most attempts the enemy stops at
  the doorway and walks back to spawn.
- **Root cause:** The follow-through depended on a ONE-TICK signal. The client
  freezes a player's reported position for the whole door fade (`Game.update`
  early-returns while `transitioning`, so `sendPosition` is suppressed), so the
  warp reaches the server as a single big position jump when the fade ends. The
  chasing enemy reaches the doorway during the freeze and is usually standing
  there _swinging_ at the frozen player. `tickEnemy` early-returns while an
  attack/hurt pose is playing (~250ms of every ~700ms ≈ a third of the time), so
  if the one-tick warp landed mid-swing the follow chance was eaten. A
  townsperson stealing aggro at the doorway, or an interior stamped close enough
  to re-lock aggro through the wall, dropped it on other ticks.
- **Fix:** `server/npcSim.js` — a detected warp is now stored in `recentWarps`
  (playerId → from/to + expiry) and stays followable for `WARP_FOLLOW_MS` (900ms)
  instead of one tick, and the door-follow check runs at the TOP of `tickEnemy`
  with priority over the aggro re-scan (so townsfolk/short warps can't preempt
  it). A `warpStack`-top guard stops an enemy re-following the same door. The
  freeze is intentionally left alone — it's what lets the pursuer catch up to the
  doorway.
- **Verified:** `npm run verify` (typecheck + `node --check` + gameHost/combat
  tests) green. Behavioural check is in-game (no timer-free unit hook for the
  chase loop yet).
- **Symptom:** Going UP the dept-store escalators was fine, but turning around to
  ride DOWN, a black shroud covered the escalator/landing and the player got
  stuck at the bottom, unable to reach the floor below (and the next escalator
  down showed black too).
- **Root cause:** EB stacks dept-store floors as SEPARATE room-crop regions
  joined only by the solid escalator ramp. The ride glides the player across the
  ramp but the active crop stayed on the FLOOR THEY LEFT, so the destination
  floor (and the down-ramp, which is below the floor where `WALL_S = 0` adds no
  downward dilation) rendered black — you glide into a void and can't see/step
  onto the landing. (Going up happened to look okay because the up-ramp is above,
  under the `WALL_N` dilation.)
- **Fix:** `Game.computeRideBounds` — when a ride has no door-warp, the active
  room for the ride's duration is the UNION of the floor being left, the floor
  being arrived on (found by marching the ramp to its end), and the ramp tiles
  between. The ride then re-crops to the destination floor on arrival as before.
  Door-warp rides (which fade) are unchanged.
- **Verified:** in-game down-ride — ramp + both floors visible throughout, player
  lands on the floor below inside the room (not sealed/stuck); up-ride still works
  (no regression).
- **Known follow-ups:** the ride trigger window is small (`STAIR_TRIGGER = 5`),
  so a sloppy diagonal approach can still walk past an escalator without starting
  the ride.

### Half the dept-store escalators dead — stuck on the steps (FIXED 2026-06-20)

- **Symptom:** only the "bottom" Twoson dept-store escalator worked; stepping onto
  the others (in prod) left the player stuck on the steps, unable to move.
- **Root cause:** EB escalator triggers come in pairs — one end carries the
  travel `direction` (NW/NE/SW/SE), the FAR landing is `StairDirection.NOWHERE`
  (`0x8000`). `STAIR_DIR_VEC` had no `0x8000` entry, so `DoorManager` dropped
  every NOWHERE trigger. The escalator steps are SOLID (the ride is what crosses
  them), so a landing with no ride = stuck. (All 6 Twoson dept-store escalators
  are `type:3` escalators; their landing ends are NOWHERE.)
- **Fix:** keep NOWHERE triggers (`DoorManager`, `StairData.nowhere`) and infer
  their diagonal at ride start (`Game.inferStairDir`): probe the 4 diagonals one
  minitile out, keep the OPEN (ramp) ones, and pick the one the player is walking
  INTO (heading · diagonal > 0). No open diagonal lines up with the heading →
  no ride, the player just walks past. Reuses the same `isSolidAtPoint` ramp test
  the ride already uses; the inferred `dy` drives `getStairExit`/`computeRideBounds`.

### Black box over shop counters (Twoson dept-store 3F register) (FIXED 2026-06-14)

- **Symptom:** A black rectangle sat over the counter/register on the dept-store
  3rd floor (and the same class of black box on other shop counters) — same look
  as the cycle-shop floor holes.
- **Root cause:** The walkable strip BEHIND a counter (where the clerk stands)
  is an enclosed pocket the flood never reaches; the pocket merge is supposed to
  reclaim it. But a wide shop's back-wall row is often its OWN sector that holds
  no floor minitiles, so it is not a `floodSector` — and the pocket merge only
  scanned `floodSectors`. The counter pocket was never even considered, so its
  tiles dropped out of the mask and rendered black.
- **Fix:** The pocket merge now scans `floodSectors` PLUS same-style **indoor**
  sectors directly adjacent to them (the back-wall sectors). The door-rejection
  is unchanged, so a real neighbour room (which always has a door mat) still
  can't be merged; caves are excluded (indoor-only) so dungeon crops are
  untouched. Mirror in `Collision.ts` + `tools/debug_room_crop_check.py`.
- **Verified:** in-game — the 3F register and the 2F bakery counter now render
  fully; a +40-tile room (a cafe whose stage was being cut off) renders as one
  coherent room. Canonical sweep: 23 indoor rooms change, all pure additions
  (0 removals), indoor multi-style still 0 (no merges), 0 NO-CROP nulls.
- **NOT this fix:** the black areas to the _sides_ of dept-store escalators are
  the boundary to the adjacent FLOOR (a separate room, correctly masked) and
  some `arr=0` empty map tiles — a multi-floor-building/escalator-handoff matter,
  not a counter pocket.

### Black squares in the Twoson cycle shop floor (FIXED 2026-06-14)

- **Symptom:** The cycle shop interior was missing pieces of its floor —
  black squares ate the lower-left corner (under the bicycles), beneath the
  shop's shelving/counter.
- **Root cause:** Those floor minitiles sit on the parasitic walkable strip
  that EB packs under in-room furniture — the strip has a SOLID cell directly
  above it (the shelf), which is exactly the signature the room flood's
  anti-slip-under-a-wall guard refuses to cross (it can't tell "under my own
  shelf" from "under the wall into the next room"). So the guarded flood never
  reached the floor's lower edge, and the door-aware pocket merge couldn't
  rescue it either: that same bottom strip runs straight into the packed
  NEIGHBOUR room's sector (a different tileset/palette), so the pocket leaked
  out of `floodSectors` and was rejected wholesale. The orphaned cells
  rendered black.
- **Fix:** A guard-free fill pass after the pocket merge
  (`Collision.computeRoomBounds`): grow outward from `visited`, but refuse to
  leave `floodSectors` and never step onto a door cell. That fills the room's
  OWN floor (same sectors, no door between) while making a neighbour-room merge
  structurally impossible — neighbours always live in a different sector or
  behind a door mat. The room-bounds algorithm lives in
  `Collision.computeRoomBounds` and is mirrored by the canonical verifier
  `tools/debug_room_crop_check.py` (KEEP IN SYNC).
- **Verified:** in-game screenshot (floor now complete, no black squares) and
  the canonical sweep — only 6 indoor rooms change, all pure additions (0
  removals), indoor multi-style rooms still 0 (no building merges), 0 NO-CROP
  nulls. Other shops with the same furniture layout were silently fixed too.

### Escalators dead — black/uncrossable, can't reach the next floor (FIXED 2026-06-14)

- **Symptom:** In the Twoson dept store the escalators showed as black squares
  and the player could not climb them to the 2nd floor ("can't even get half
  way up it").
- **Root cause:** Three stacked issues.
  1. **Never implemented.** EB's `EscalatorOrStairwayDoor` (extracted as
     `type:"stair"` in `doors.json`) is NOT a warp — it carries only a diagonal
     `direction` (CoilSnake `StairDirection`: NW=0, NE=0x100, SW=0x200,
     SE=0x300), no destination. `DoorManager` did `if (type !== 'door')
continue`, so stairs did nothing.
  2. **The escalator is a walkable diagonal RAMP** (bottom landing strip →
     diagonal ramp → top landing strip), bounded by SOLID at each end. It's
     corner-connected and only ~2 minitiles wide, so the 14px player foot-box
     can't walk up it, and the room-seal's anti-under-wall gate compounds it.
     Real EB _glides_ you along the ramp, ignoring collision. The floor change
     itself is a normal `door` at the strip ends (those already worked).
  3. The shaft is its own room; the camera crop already spans the whole shaft
     (gated flood = full 66-cell shaft for Twoson), so the "black around" is
     just the isolated pocket's walls — not a missing-tile bug.
- **Fix:** Implemented an escalator **ride** (glide) that ends in a **floor
  warp**. The shaft is a separate map region; the floor change is a `door` at
  its end (the dept-store floors are NOT one walkable space — even an ungated
  flood gives an isolated 66-cell shaft; they're joined only by door links,
  which is what the editor draws as "connected").
  - `DoorManager.getStairAt()` → the trigger's diagonal vector (`STAIR_DIR_VEC`).
  - `Player.rideStep()` moves diagonally one frame, bypassing collision.
  - `Game.updateRide()` glides until the minitile ahead along the ramp is solid
    (the landing), then **warps** via `getStairExit()`. The active-room crop is
    left intact during the glide (an earlier attempt nulled it → black void).
  - `DoorManager.getStairExit()` floods the shaft and picks the `door` inside it
    that warps to an indoor/croppable floor (skipping the building's outdoor
    exit) in the ride's vertical direction (UP → smallest destY). Returns null
    for over-large shafts (open-floor banks) → ride just stops in place.
  - `Collision.isSolidAtPoint()` is the raw look-ahead used for arrival/flood.
- **Verified (data replay):** riding UP Twoson escalator A warps to tile
  (127,160) — the indoor 2F room, which then crops/renders fully. No
  `doors.json` re-extraction needed (data was present, just ignored).
- **Known limits / follow-ups:** (a) The DOWN/return direction is ambiguous in
  the door data (both Twoson escalators' indoor-floor doors collapse to the same
  target) — needs in-game testing; may need editor-authored escalator dests.
  (b) Fourside's dense multi-escalator banks have over-large shafts → no warp
  yet (ride stops in place); needs testing. (c) Steps don't visually scroll — EB
  animates them via tile/palette cycling, which our static-atlas renderer
  doesn't do yet (TODO: tile-animation system). (d) Ladders/ropes
  (`RopeOrLadderDoor`) are vertical climbs with the same gap — not yet handled.

### Head floats in front of stop signs / poles everywhere — priority bit semantics (FIXED 2026-06-12, supersedes the bench entry below)

- **Symptom:** Standing behind a stop sign (and "wherever I try" — any sign,
  pole, or 0x03-flagged surface map-wide): body hidden behind the object but
  the HEAD drawn in front of it.
- **Root cause:** Two stacked misreadings of EB's sprite-priority bits.
  The engine originally treated 0x01 = lower half behind FG and 0x02 = UPPER
  half behind; the bench fix (below) then mapped 0x03 → lower-half only.
  EB's REAL semantics (community tile-attribute docs, confirmed against our
  extracted data): **0x01 = lower body hidden, 0x02 = WHOLE body hidden —
  there is no upper-half bit.** The Onett stop sign data reads perfectly
  under this: the row pressed against the pole is 0x03 (whole hidden — your
  full sprite overlaps the signboard), the rows farther back are 0x01 (legs
  behind the board, head above the sign top). Mapping 0x03 to lower-only
  floated the head in front of every sign on the map.
- **Why the bench fix misled:** the "Onett hospital bench" sitters at
  (6984,9800) are actually Paula + teddy bear in the Happy Happy cabin; the
  torso-swallowing artifact came from rendering NPCs with whatever FG band
  overlaps them, not from wrong bit semantics. Under ROM semantics they
  render naturally (verified). If a real seated-NPC artifact resurfaces, the
  fix is seat-appropriate sprites/anchors — NOT bending the global bit rule.
- **Fix:** `Renderer.enqueueSprite`: `0x02` set (incl. 0x03) → whole sprite
  behindFG; `0x01` alone → split lower-behind/upper-front; health bar hides
  only with the whole body. Comments updated to the ROM semantics.
- **Verified:** in-game screenshots via `tools/verify_priority.mjs` (kept as
  a verifier): pressed behind the Onett stop sign = fully hidden behind the
  board; one row back = cap visible above the sign, body behind; cabin
  sitters render normally. Lower-only surfaces (grass/hedge strips)
  unchanged. `npx tsc --noEmit` clean. Screenshots deleted (ROM pixels).

### Bench sitters' torso swallowed by the bench (Onett hospital) (FIXED 2026-06-12 — SUPERSEDED by the entry above; its 0x03→lower-only rule was wrong)

- **Symptom:** Two people sitting on the bench inside the Onett hospital showed
  only their head and feet — the torso was hidden behind the bench. Same for any
  NPC seated on a tile flagged this way (5 indoor persons map-wide).
- **Root cause:** EB flags some seat/bench minitiles with collision byte 0x03 —
  BOTH sprite-priority bits (0x01 lower-behind AND 0x02 upper-behind) on one
  walkable tile (confirmed in the extracted collision: the seat minitiles under
  the sitters are literally 0x03, not an OR of neighbours). `getSpritePriority`
  returned 0x03 and the renderer's `enqueueSprite` treated "both bits" as
  "whole sprite behind the FG layer." The bench's foreground band then occluded
  the entire middle of the sprite, leaving only the head (above the band) and
  feet (below it) visible.
- **Fix:** `Renderer.enqueueSprite` no longer has a whole-behind case. 0x03 is
  treated the SAME as 0x01 (lower half behind FG, upper half in front) — the
  normal seated look. Pure 0x02 still drops the upper half (tree canopies); the
  124 existing 0x01 sitters render identically. The health-bar layer now follows
  the real upper-half placement (`upperHalfBehind = 0x02 && !0x01`), so a 0x03
  sitter's bar stays in front with its head instead of hiding behind the bench.
- **Verified:** `npx tsc --noEmit` clean. Identified the 5 affected `0x03`
  indoor persons (incl. the hospital bench pair at px ~(6984,9800)/(7000,9816))
  by replaying `getSpritePriority` over `npcs.json`; all now render lower-behind.

### Props AND people misplaced (drugstore ATM/phone, NPCs inside shelves) — anchor wrong AGAIN (FIXED 2026-06-12)

- **Symptom:** Reported in the Onett drugstore: ATM and phone off their
  spots, and the room's people wrong too — the dog and a kid embedded in
  the shelf units, clerks standing in the counter footprint. THIRD round
  with this bug (see the 2026-06-11 entry below, which this supersedes).
- **Root cause:** map_sprites.yml placement Y is 8px ABOVE the feet; the
  true anchor is center-x / feet = Y + 8. Both earlier interpretations were
  wrong: top-left + (w/2, h) overshot down-right; raw pass-through (the
  2026-06-11 "fix") undershot by 8px vertically. Each had looked "verified"
  because one or two hand-picked props (traffic light, ATM) coincidentally
  lined up with furniture solids at hand-checked spots. **Lesson: never
  verify placement semantics on single examples — only a map-wide
  statistic discriminates.**
- **Fix:** `tools/extract_npcs.py` adds +8 to Y; re-ran extraction.
  Solved/verified with NEW `tools/debug_person_anchor_stats.py`: persons
  always stand on walkable ground, so the right offset minimizes person
  foot boxes landing on solid collision. Result over all 1084 person
  placements: (+0,+8) → 7.0% blocked (sitting NPCs etc.) vs raw (+0,+0) →
  31.5%, top-left → 20.6%, center-center → 19.9%; nearest competitor
  (+8,+8) → 14.3%. Visual re-check via `tools/debug_npc_align.py` renders:
  drugstore (dog/kid out of the shelves, clerks behind the counter, ATM
  machine grounded against the back shelving) and the Onett intersection
  (traffic light base on the sidewalk corner, stop sign on the road edge).
  Keep `debug_person_anchor_stats.py` as the canonical checker if anchor
  questions come up again.
- **Follow-up (same day):** after the data fix, NPCs looked right on room
  entry then SNAPPED BACK to pre-fix spots — the running dev server's npcSim
  still held the old npcs.json in memory and its authoritative npc_update
  rows overrode the client (the drugstore "pay phone" placement is typed
  `person` in the ROM config, so it shifted too). npcSim now hot-reloads
  npcs.json on change (fs.watchFile, 2s poll) and re-broadcasts all persons;
  clients still need a browser refresh for props. (The watcher code itself
  went live automatically — nodemon watches server/\*.js and restarts the dev
  server on CODE changes; it deliberately ignores data files, which is
  exactly why this in-process hot-reload is needed for npcs.json.)

### Visible + walkable neighbor rooms inside buildings — arcade/Tracy's room (FIXED 2026-06-11)

- **Symptom:** Standing in one Onett interior (reported as "arcade 1st
  floor"), the neighboring rooms of OTHER buildings (Tracy's room, the
  bakery, etc.) were visible and physically enterable by walking — no door
  needed. 24 rooms map-wide merged across building boundaries.
- **Root cause:** Two stacked issues. (1) EB packs interior rooms into a
  lattice and the BOTTOM minitile row of each sector row is walkable in the
  ROM — including UNDER the walls between rooms. The room flood-fill walked
  that 1-cell-tall strip and merged adjacent buildings into one "room", so
  the mask showed both. (2) The player's 8px-tall foot box physically fits
  the strip, and the strip rows pass ~8px BELOW door trigger zones
  (`getDoorAt` checks midsection ±8), so you could walk under a warp mat
  straight into the neighbor. The ROM gets away with this because real EB
  rooms are only exited via mats; the strip is unreachable dead space there.
- **Fix:** Three parts in `Collision.ts`:
  1. Flood gate — horizontal expansion may not enter an INDOOR-sector cell
     with solid directly above (kills under-wall strips). Dungeon cells keep
     free expansion: caves have legitimate 1-cell squeezes and cliff ledges
     (a global gate broke 10+ cave rooms in testing).
  2. Door-aware pocket merge — unreached walkable regions inside the room's
     sectors merge only if they contain NO door mat/destination (registered
     by DoorManager from the raw table). Real neighbor rooms always have
     doors; clerk pockets never do — without this, a neighbor room sharing
     a sector merged right back in as a "pocket".
  3. Movement seal — `RoomBounds.cells` (the room's walkable minitiles) +
     `checkPlayerCollision`: while a room is active, minitiles outside it
     act solid for the local player. Leaving a room takes a door, period.
     The door-transition nudge runs AFTER the destination room is computed
     so it can't push the player out.
- **Verified:** canonical sweep (`tools/debug_room_crop_check.py`, updated
  to mirror the new algorithm): 381 rooms, 0 indoor rooms spanning multiple
  sector styles (was 24); the only multi-style rooms left are 4 dungeons
  whose cave complexes legitimately span styles. Live (Playwright +
  `debugTeleport`): free walking inside the bakery, hard stop at the room
  edge, strip-slide into the neighbor blocked from both sides, neighbor
  rooms render pure black, cave movement + exit door still work, outdoor
  movement unconstrained. Beware when testing teleports: a raw
  `debugTeleport` does not nudge — feet must land so the 14x8 foot box
  (y-8..y) clears solids, or the player is stuck and everything looks
  "blocked".

### "Magicant" door lands inside solid rock (FIXED 2026-06-11)

- **Symptom:** The door pair at world px (6440/6448, 4808) targets dest
  (3192, 1152) — every minitile within 48px of the destination is solid.
  A player taking that door would be stuck in the wall, and no room crop
  could compute (the sweep's single null). Was logged as a Magicant /
  Sea-of-Eden water issue — both guesses wrong.
- **Root cause:** It's not Magicant (the pink Magicant chunk just sits
  adjacent on the stitched map) and not water: it's the hole in the Tenda
  Village cave floor that drops you into the Lost Underworld. It's a
  SCRIPTED door — EB never uses its stored Destination field (a dummy
  pointing into solid cave filler). Entering runs the door's text script
  (`data_51.l_0xc99ccd` → `l_0xc99cd8`): falling music + pause, then
  `{warp(59)}` → `teleport_destination_table.yml` entry 59 = (358, 385)
  in 8px units = px (2864, 3080), walkable Lost Underworld ground. (Warp
  table units verified statistically: 206/234 entries land walkable as
  8px units vs 81/234 as raw pixels.) Our DoorManager only reads the
  Destination field, so it warped into rock. General lesson: any door
  with a non-`$0` Text Pointer may do its real warp in ccscript.
- **Fix:** Added the two hole doors ("6448,4812" / "6456,4812") to
  `ZONE_DOOR_OVERRIDES` in `DoorManager.ts` with dest px (2864, 3080),
  facing down, style 1 — and mirrored the override in
  `tools/debug_room_crop_check.py` (`DOOR_DEST_OVERRIDES`, now resolving
  each door's world-anchor key like the engine does) so the canonical
  sweep stays faithful.
- **Verified:** `tools/debug_room_crop_check.py`: NO-CROP destinations
  0 (was 1), same 353 unique rooms, remaining flags are the two known
  minor open items. Landing spot collision checked directly (byte 0x00,
  open 5x5 neighborhood) and rendered via `tools/debug_reach.py`
  (`tools/_warp59_dest.png` — Lost Underworld valley, 10k+ reachable
  minitiles). `npx tsc --noEmit` clean.

### Props placed wrong: ATM/phone off the wall, traffic lights in the grass (FIXED 2026-06-11 — INCOMPLETE, superseded by the 2026-06-12 entry above)

- **Symptom:** Most `object`/`item` props sat down-right of where the real
  game puts them: the Onett drugstore ATM stood mid-floor instead of against
  the back wall, the phone hotspot was off its counter, and Onett's traffic
  lights stood in the grass next to bushes instead of on the road-corner
  sidewalks. (Persons were fine.)
- **Root cause:** `tools/extract_npcs.py` treated object/item placements in
  `map_sprites.yml` as the sprite's TOP-LEFT corner and converted them to the
  engine anchor by adding (w/2, h) — shifting every prop half a sprite right
  and a full sprite down. In truth ALL placement types use the same
  center-x/feet-y anchor the engine already uses. The wrong interpretation
  had once looked "verified" because a bush's solid collision tiles happened
  to sit exactly where the shifted traffic light's feet landed — when
  checking placements against collision, beware furniture/bush solids
  coinciding by accident.
- **Fix:** removed the conversion (props now pass through like persons) and
  re-ran extraction. Verified two ways: `tools/debug_npc_align.py` renders of
  the Onett intersection + drugstore (traffic light pole base on the sidewalk
  corner, ATM on the back wall), and in-game via `tools/verify_props.mjs`
  (debugTeleport + screenshots; Q on the drugstore phone hotspot returned its
  ROM dialogue). Note: many props (phones, signs) are invisible interaction
  hotspots — the visible phone/sign is map tiles; don't mistake the empty
  hotspot for a misplacement.

### Neighboring map areas visible inside caves/dungeons (FIXED 2026-06-11)

- **Symptom:** Standing in any cave or dungeon room (e.g. the cave north of
  Onett, room with the present, door dest ≈ pixel 1080,2136), the camera
  freely shows unrelated map chunks packed next to the dungeon on the big
  stitched map. Same class of bug as the earlier interior-room bleed, but
  for caves nothing was cropped at all.
- **Root cause:** Room cropping (`Collision.computeRoomBounds`) only ran for
  sectors flagged `Setting: indoors` in `map_sectors.yml`. EarthBound flags
  caves/dungeons with a _different_ setting — `exit mouse usable` (650
  sectors) — so `isIndoorTile()` returned false and `computeRoomBounds`
  bailed with null: no camera clamp, no mask, no black-out.
- **Fix:** `tools/add_sector_settings.py` now emits `dungeon: true` for EVERY
  special (non-"none", non-"indoors") setting — `exit mouse usable` plus the
  magicant/robot/lost-underworld sprite modes, since all mark off-overworld
  chunks (and a robot-sprites column sits _inside_ the Cave of the Past
  cluster, so floods must cross settings or rooms split mid-cave). The
  engine treats `indoor || dungeon` as room-croppable
  (`MapManager.isRoomCroppableTile`, used by both the computeRoomBounds
  entry gate and the flood-fill sector constraint).
- **Verified:** `tools/debug_room_crop_check.py` (faithful Python replay of
  the whole mask algorithm) over every door destination: 194 indoor + 159
  dungeon unique rooms, 0 un-cropped dungeon rooms (1 null = the broken
  Magicant door above), holes confined to mask-perimeter walls, and the
  only 2 indoor-mask changes are rooms that walkably continue into
  dungeon-flagged sectors (previously cut by a black wall mid-room — now
  merged). Live-verified in the Onett cave via `__eb.game.debugTeleport`
  (screen columns outside the room: 100% black; crop clears outdoors).
