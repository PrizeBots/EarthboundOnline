# EarthBound Online

## Architecture
- **Browser prototype is the testbed** — all features must mirror real SNES hardware behavior
- Final target: custom SNES ROM (PVSnesLib) + ESP32 co-processor for multiplayer
- Pipeline: browser prototype → multiplayer → ROM build → real hardware
- Implement features in ways that port cleanly to SNES (SPC700 for audio, BG layers for tiles, OAM for sprites)

## Dev Server
- Always use port **4444** for Vite dev server (`npm run dev` or `npx vite --port 4444`)
- Port 3000 is taken by another project — never use it

## Project Structure
- `tools/` — Python extraction scripts (uses CoilSnake libraries to parse EarthBound.sfc)
- `public/assets/` — Extracted game data (atlases, sprites, map JSON, collision JSON)
- `src/engine/` — TypeScript game engine (Canvas-based renderer, no emulation)
- `eb_project/` — Full CoilSnake decompiled project (music packs, scripts, NPC data, door data)
- ROM file: `EarthBound.sfc` (do not commit)

## Data Pipeline
1. `python tools/extract_rom.py` — extracts tilesets, map, sprites, collision from ROM
2. `python tools/build_atlases.py` — pre-renders BG + FG tile atlases with correct palettes
3. `npm run dev` — runs the game in browser

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
