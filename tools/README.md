# tools/ — extraction & verification scripts

Python scripts that parse `EarthBound.sfc` / the CoilSnake `eb_project/` into the
pure-index JSON + atlas PNGs the engine loads. **Never distribute ROM-derived
output** (CLAUDE.md). Run Python with the full path
(`C:/Users/zleer/AppData/Local/Programs/Python/Python310/python.exe`) — the bare
`python` alias may hang.

> Scratch renders (`tools/_*.png`, screenshots) are gitignored — they contain
> ROM-derived pixels. Don't commit them.

## Pipeline (run in order)

Run the whole thing with `npm run extract` (→ `convert_all.py`, which runs the
six steps below in order, stopping on the first failure). The canonical build,
mirrored in ARCHITECTURE.md "Data pipeline":

1. `extract_rom.py` — tilesets, map, sprites, collision from the ROM
2. `add_sector_settings.py` — merges per-sector Setting byte → `sectors.json`
   (`indoor`/`dungeon`/`town`)
3. `apply_map_changes.py` — bakes open-world event state into `tiles.json`
4. `build_atlases.py` — pre-renders BG + FG tile atlases per palette
5. `extract_npcs.py` — NPC/prop placements (`npcs.json`) + dialogue
   (`npc_text.json`, via `eb_dialogue.py`)
6. `extract_shops.py` — shop catalog + clerk→store map (`shops.json`)

### Other generators (run as needed, not every build)

- **Music**: `extract_music_map.py`, `map_spc_to_songs.py`, `build_spc_mapping.py`,
  `extract_song_names.py`, `seed_music_areas.py`
- **Traffic**: `extract_vehicle_colboxes.py` (per-direction car boxes),
  `gen_vehicle_traffic.py` (links static car props → traffic routes)
- **Char select / menus**: `extract_char_parts.py`, `build_char_select.py`,
  `extract_menus.py`

## Verifiers (keep green — referenced by editor/docs)

Replay engine algorithms in Python/headless Chromium to catch regressions.
The two starred ones are wired into the editor's "Verify" buttons
(`vite.config.ts` VERIFIERS) — keep them in sync with the engine they mirror.

- ★ `debug_room_crop_check.py` — replays the room-crop flood over every door
  destination (mirrors `Collision.ts`); cited across ARCHITECTURE/bugs/EDITOR_TOOLS
- ★ `debug_person_anchor_stats.py` — asserts every person stands on walkable
  ground map-wide (mirrors the NPC anchor; see `extract_npcs.py`)
- `verify_dialogue.mjs`, `verify_editor.mjs`, `verify_priority.mjs`,
  `verify_props.mjs` — Playwright drives the real game and screenshots flows
  (delete the screenshots — ROM pixels)

## debug_*.py — one-off investigations

Scratch scripts written while solving a specific bug (see bugs.md). **Not part of
the build.** A handful are still cited by docs/code and should be kept
discoverable:

- `debug_sprite_contact.py`, `debug_name_mining.py`, `debug_name_mining2.py`,
  `debug_name_evidence.py` — how the sprite roster was named (see `SpriteNames.ts`)
- `debug_door_align.py` (`DoorManager.ts`), `debug_npc_align.py`,
  `debug_reach.py` (bugs.md)

The rest (`debug_compose_scene`, `debug_fg_layer`, `debug_find_cave`,
`debug_find_props`, `debug_list_area_props`, `debug_name_audit`, `debug_pri_flags`,
`debug_props_with_text`, `debug_prop_anchor`, `debug_render_room`,
`debug_room_ascii`, `debug_room_bleed`, `debug_room_bounds4`, `debug_room_inspect`,
`debug_sector_claims`, `debug_sector_settings_map`, `debug_sitter_movement`,
`debug_solid_pri`, `debug_spawn_dialogue`, `debug_tile_info`) are kept only as a
record of past investigations — reuse or delete freely.
