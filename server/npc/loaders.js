'use strict';
// Enemy/entity config loaders, extracted from npcSim.js (Phase 2 modularization).
// Reads our own content (enemy_spawns.json), the authored entity master table
// (entities.json), and the ROM-derived enemy catalog (enemies.json), and merges
// them into effective per-entity stat defs. npcSim owns the file WATCH for the
// override files (its reload handlers also rebuild the live pools), so we just
// expose the load fns + the override paths it needs to watch. KEEP IN SYNC with
// src/engine/NPCManager.ts (loadNPCs reads the same files + merge order).
const fs = require('fs');
const path = require('path');

function createLoaders(assetsDir) {
  const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(assetsDir, rel), 'utf8'));

  // --- Enemy config (our own content — public/assets/map/enemy_spawns.json) ---
  // The Enemy Spawner editor writes the WHOLE file to the overrides layer; it
  // wins over the committed default.
  const ENEMY_FILE = 'map/enemy_spawns.json';
  const ENEMY_OV_PATH = path.join(assetsDir, '..', 'overrides', 'enemy_spawns.json');
  function loadEnemyCfg() {
    try {
      return JSON.parse(fs.readFileSync(ENEMY_OV_PATH, 'utf8'));
    } catch {
      /* no override authored — fall back to the committed default */
    }
    try {
      return readJSON(ENEMY_FILE);
    } catch {
      return null; // no enemies if neither file is present
    }
  }

  // The UNIVERSAL entity master table (per sprite-group stats for EVERY kind),
  // authored in the Entity Manager → overrides/entities.json. Back-compat: fall
  // back to enemy_spawns.json `entities` for saves made before the split.
  const ENTITIES_OV_PATH = path.join(assetsDir, '..', 'overrides', 'entities.json');
  function loadEntities() {
    try {
      const d = JSON.parse(fs.readFileSync(ENTITIES_OV_PATH, 'utf8'));
      if (d && d.entities) return d.entities;
    } catch {
      /* no entities.json yet — fall through to the legacy location */
    }
    const cfg = loadEnemyCfg();
    return (cfg && cfg.entities) || {};
  }

  // ROM-derived enemy catalog (tools/extract_enemies.py → assets/map/enemies.json):
  // the DEFAULTS layer of per-entity stats, keyed by sprite id. Merged UNDER the
  // authored entities. Rarely changes (re-extracted from ROM), so loaded once.
  const ENEMY_CAT_PATH = path.join(assetsDir, 'map', 'enemies.json');
  function loadEnemyCatalog() {
    try {
      return JSON.parse(fs.readFileSync(ENEMY_CAT_PATH, 'utf8'));
    } catch {
      return null; // no catalog extracted — runtime falls back to authored/defaults
    }
  }
  const enemyCatalog = loadEnemyCatalog();

  // Effective per-entity stats = catalog (ROM defaults) overlaid by the authored
  // entity table. Merge order: DEFAULT < catalog (ROM) < entities (authored).
  function buildEntityDefs(entities) {
    const cat = (enemyCatalog && enemyCatalog.bySprite) || {};
    const file = entities || {};
    const out = {};
    for (const k of new Set([...Object.keys(cat), ...Object.keys(file)])) {
      out[k] = Object.assign({}, cat[k], file[k]);
    }
    return out;
  }

  return {
    loadEnemyCfg,
    loadEntities,
    buildEntityDefs,
    enemyCatalog,
    // npcSim watches/unwatches these (its reload handlers rebuild the pools).
    enemyOvPath: ENEMY_OV_PATH,
    entitiesOvPath: ENTITIES_OV_PATH,
  };
}

module.exports = { createLoaders };
