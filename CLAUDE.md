# Zexonyte Online

Always reply with concise language. I do not great reading comprehension or attention skills. Give me what matters most and get to the point always.

We are building a game engine to modify earthbound rom into an MMO hack n slash games.

Always speak up with your ideas. Failing to plan is planning to fail! We are a team!

Remember our goal is beautiful architecture and tooling that lets us craft the greatest online fan game the worlds ever seen.

Lets go!

## Architecture

- **The browser multiplayer game IS the project** — a custom SNES ROM (PVSnesLib) + ESP32
  co-processor port is a long-term ambition, currently backlogged and out of scope
- Still implement features in ways that would port cleanly to SNES (SPC700 for audio,
  BG layers for tiles, OAM for sprites) — it keeps the engine honest and the option open
- **[ARCHITECTURE.md](ARCHITECTURE.md) is the technical map** of the engine, servers, and
  extraction pipeline. Review it before working on those systems, and update it in the
  same change whenever you alter how they work.

## ROM & Asset Distribution (PokeMMO model)

**We must never distribute ROM-derived data.** Target architecture (build-out is a
pre-launch TODO; see TODO.md):

- Players supply their own `EarthBound.sfc` via a file picker before character select.
  The ROM is checksum-verified and NEVER uploaded — it stays in the player's browser.
- All assets (sprites, atlases, map, collision, fonts, music data) are
  extracted client-side in a Web Worker (TypeScript port of the `tools/` pipeline) and
  cached in IndexedDB/OPFS. AssetLoader reads the cache, not HTTP.
- The deployed site/server ships code only. The multiplayer server already never
  touches assets (it just relays join/move/chat) — keep it that way.
- Dev workflow is unchanged: extract locally from your own ROM into `public/assets/`
  for fast iteration. Those files must be excluded from production builds, and the
  ones currently committed must be scrubbed from git history before launch.
- Never commit: `EarthBound.sfc`, `eb_project/`, `public/assets/` contents, or any
  new file containing ROM-derived pixels/audio/data tables. Code, our own configs,
  and pure-index metadata we author are fine.

## Dev Server

- **The dev server is essentially always already running on port 4444** — the
  maintainer keeps `npm run dev` up. Assume `http://localhost:4444` is live;
  just open/refresh it rather than starting a new server. Don't spawn a second
  dev server (the port is taken — `strictPort` will fail) and don't kill the
  running one without asking.
- Always use port **4444** for Vite dev server (`npm run dev` or `npx vite --port 4444`)
- Port 3000 is taken by another project — never use it
- If you spin up a server on any OTHER port for a one-off test, **stop it when
  you're done** — don't leave stray dev servers running. Track its PID (or run
  it in a scoped/background job you can kill) and shut it down before finishing,
  so 4444 stays the only long-lived server.

## Project Structure

- `tools/` — Python extraction scripts (uses CoilSnake libraries to parse EarthBound.sfc)
- `public/assets/` — Extracted game data (atlases, sprites, map JSON, collision JSON)
- `src/engine/` — TypeScript game engine (Canvas-based renderer, no emulation)
- `eb_project/` — Full CoilSnake decompiled project (music packs, scripts, NPC data, door data)
- ROM file: `EarthBound.sfc` (do not commit)

## Data Pipeline

1. `python tools/extract_rom.py` — extracts tilesets, map, sprites, collision from ROM
2. `python tools/apply_map_changes.py` — bakes the open-world event state into tiles.json
   (the ROM's base map is the game-intro state: police barricades block Onett's roads)
3. `python tools/build_atlases.py` — pre-renders BG + FG tile atlases with correct palettes
4. `python tools/extract_enemies.py` — enemy catalog (`enemies.json`): per-sprite stats +
   item drops from the ROM, keyed by sprite id. Combat's default stat layer (see ARCHITECTURE.md).
5. `python tools/extract_gifts.py` — present-box catalog (`gifts.json`): each gift's contents
   (item) + ROM flag, keyed by placement. Authored via the Gift Manager tool (see ARCHITECTURE.md).
6. `npm run dev` — runs the game in browser

## Rendering

- Uses EarthBound's native dual-layer system: BG atlas (minitiles 0-383) behind sprites, FG atlas (minitiles 512-895) in front
- Foreground atlas files: `{mapTS}_{pal}_fg.png` — transparent except where foreground pixels exist
- Collision byte bit 7 (0x80) = solid wall; bits 0-1 = sprite priority flags

## Music

- EarthBound music: SPC700 engine + BRR samples + EBM song data in `eb_project/Music/`
- Each sector has a `musicId` in sectors.json
- Use SPC700 emulation in browser (not pre-rendered audio) — same engine runs natively on real SNES hardware

## Python

- Use full path: `C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe`
- The `python` alias may hang; always use the full path
