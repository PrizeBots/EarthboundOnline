import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { buildAssetBundle } from '../../src/extract/bundle';

/**
 * Worker-core test: buildAssetBundle() must produce the exact asset set the
 * engine loads — JSON matching the committed files, a sprite image per group,
 * and an atlas per combo the committed `public/assets/atlases/` has (so no area
 * renders blank). Image pixels spot-checked via the MD5 fixtures.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const romPath = resolve(root, 'EarthBound.sfc');
const assets = resolve(root, 'public/assets');
const haveInputs = existsSync(romPath) && existsSync(resolve(assets, 'atlases'));

const load = (p: string) => JSON.parse(readFileSync(resolve(assets, p), 'utf8'));
const md5 = (b: Uint8ClampedArray) => createHash('md5').update(Buffer.from(b.buffer)).digest('hex');

describe('buildAssetBundle (Web Worker core)', () => {
  // Renders the FULL atlas set — every static + animation-frame atlas (hundreds of
  // 1024×1024 buffers). Well over vitest's 5s default under parallel load, so give
  // it room. (Skipped in CI anyway — needs a local ROM.)
  it.skipIf(!haveInputs)('reproduces the engine asset set from a ROM', { timeout: 60_000 }, () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const bundle = buildAssetBundle(rom);

    // JSON matches committed files.
    expect(bundle.json['map/tiles.json']).toEqual(load('map/tiles.json'));
    expect(bundle.json['map/sectors.json']).toEqual(load('map/sectors.json'));
    expect(bundle.json['map/doors.json']).toEqual(load('map/doors.json'));
    expect(bundle.json['tilesets/0/arrangements.json']).toEqual(
      load('tilesets/0/arrangements.json')
    );
    // Text layer (music + shops match exactly; npc_text is a superset of the
    // committed placed-NPC subset, so just check it's populated).
    expect(bundle.json['music/music_map.json']).toEqual(load('music/music_map.json'));
    expect(bundle.json['map/shops.json']).toEqual(load('map/shops.json'));
    expect(Object.keys(bundle.json['map/npc_text.json'] as object).length).toBeGreaterThan(700);

    // Every committed atlas PNG must have a produced atlas (no blank areas).
    const committedAtlases = readdirSync(resolve(assets, 'atlases')).filter((f) =>
      f.endsWith('.png')
    );
    for (const f of committedAtlases) {
      expect(bundle.images[`atlases/${f}`], `bundle is missing atlases/${f}`).toBeDefined();
    }

    // A sprite image per metadata group.
    for (const g of bundle.json['sprites/metadata.json'] as { id: number }[]) {
      expect(bundle.images[`sprites/${g.id}.png`], `missing sprites/${g.id}.png`).toBeDefined();
    }

    // Every image's buffer length must equal 4*w*h — the worker constructs an
    // ImageData from these, which throws IndexSizeError otherwise.
    for (const [path, img] of Object.entries(bundle.images)) {
      expect(img.rgba.length, `${path} rgba length`).toBe(4 * img.width * img.height);
    }

    // Spot-check actual pixels against the render fixtures.
    if (existsSync(resolve(root, 'tools/_parity/atlas_fixtures.json'))) {
      const af = JSON.parse(
        readFileSync(resolve(root, 'tools/_parity/atlas_fixtures.json'), 'utf8')
      );
      for (const [key, exp] of Object.entries(af) as [string, { bg: string }][]) {
        expect(md5(bundle.images[`atlases/${key}.png`].rgba), `${key} bg`).toBe(exp.bg);
      }
    }
  });
});
