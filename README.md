# EarthBound Online

A browser multiplayer hack-'n-slash recreation of EarthBound's overworld — a
custom TypeScript Canvas engine (no emulation) renders assets extracted from the
ROM, while a small Node server runs the authoritative multiplayer world (movement,
chat, NPC AI, combat, shops). Every system is built to port cleanly to real SNES
hardware later (BG layers for tiles, OAM for sprites, SPC700 for audio).

> **ROM policy — read first.** This project distributes **zero ROM-derived data**.
> You supply your own `EarthBound.sfc`; assets are extracted locally. Never commit
> the ROM, `eb_project/`, `public/assets/` contents, or any file containing
> ROM-derived pixels/audio/data. See [CLAUDE.md](CLAUDE.md) for the full policy.

## Quick start

```bash
npm install
# Place your own EarthBound.sfc in the repo root, then extract all assets:
npm run extract                    # runs the full pipeline (tools/convert_all.py)
npm run dev                        # Vite + game server on http://localhost:4444
```

> If the bare `python` alias hangs on your machine (see CLAUDE.md), run the
> pipeline directly with your full interpreter path:
> `…/python.exe tools/convert_all.py`.

The dev server hosts both the client and the multiplayer WebSocket server on
**port 4444**. Open two tabs to see multiplayer.

## Data pipeline (run in order)

The ROM → JSON/atlas extraction, mirrored in [ARCHITECTURE.md](ARCHITECTURE.md):

1. `extract_rom.py` — tilesets, map, sprites, collision
2. `add_sector_settings.py` — per-sector indoor/dungeon/town flags
3. `apply_map_changes.py` — bakes open-world event state into the map
4. `build_atlases.py` — pre-renders BG + FG tile atlases
5. `extract_npcs.py` — NPC/prop placements + dialogue
6. `extract_shops.py` — shop catalog + clerk→store map

See [tools/README.md](tools/README.md) for the full script map (generators,
verifiers, debug scripts). Run Python via the full interpreter path (the bare
`python` alias may hang on this machine — see CLAUDE.md).

## Project structure

| Path | What |
|------|------|
| `src/engine/` | TypeScript Canvas game engine (renderer, collision, combat, UI) |
| `src/editor/` | Dev-only in-engine authoring tools (F2; excluded from prod builds) |
| `server/` | Multiplayer host — `gameHost.js` (`GameHost`, the shared logic) + `npcSim.js` + `shops.js` |
| `tools/` | Python extraction + verification scripts |
| `public/assets/` | Extracted game data (dev-only; never shipped to production) |
| `public/overrides/` | Our authored data layer, applied on top of extraction |
| `eb_project/` | CoilSnake decompile (scripts, NPC/door tables, music) — not committed |

The **client connects to one shared server**; all of `server/gameHost.js`'s logic
runs identically in dev (via `vite.config.ts`) and in the standalone deploy
(`server/index.js`) — both are thin transports over the same `GameHost` class.

## npm scripts

| Script | Does |
|--------|------|
| `npm run dev` | Vite dev server + game server on :4444 (nodemon-restarted) |
| `npm run build` | Production client build → `dist/` |
| `npm start` | Standalone deploy server (serves `dist/` + multiplayer) |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm run check:server` | Syntax-check the server modules |
| `npm test` | GameHost smoke test — transport (join/move/chat/leave) + economy (equip/use/buy/sell) |

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — project rules: ROM policy, dev ports, conventions
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the technical map (engine, servers, pipeline)
- **[EDITOR_TOOLS.md](EDITOR_TOOLS.md)** — the dev authoring layer
- **[TODO.md](TODO.md)** — roadmap (phases 1–4, pre-launch, backlog)
- **[bugs.md](bugs.md)** — solved bugs and the reasoning behind tricky fixes
- **[tools/README.md](tools/README.md)** — extraction/verification script map

## Status

Multiplayer overworld with NPCs, dialogue, shops, equipment, server-authoritative
combat (HP/damage/death/respawn), leveling, and traffic is playable. A custom SNES
ROM (PVSnesLib) + ESP32 co-processor port is a long-term ambition, currently
backlogged. See [TODO.md](TODO.md).
