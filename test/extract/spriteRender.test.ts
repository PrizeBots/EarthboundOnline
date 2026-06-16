import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Rom } from '../../src/extract/Rom';
import { extractSprites, renderSpriteImage } from '../../src/extract/sprites';

/**
 * Parity test: renderSpriteImage() must produce byte-identical RGBA to
 * extract_sprites.py's PNG output (index 0 transparent, else group palette), via
 * MD5 of the raw buffer for a spread of groups. Ground truth from the dumper.
 */
const here = dirname(fileURLToPath(import.meta.url));
const romPath = resolve(here, '../../EarthBound.sfc');
const fixturePath = resolve(here, '../../tools/_parity/sprite_render_fixtures.json');
const haveInputs = existsSync(romPath) && existsSync(fixturePath);

const md5 = (b: Uint8ClampedArray) => createHash('md5').update(Buffer.from(b.buffer)).digest('hex');

describe('sprite image render parity with extract_sprites.py', () => {
  it.skipIf(!haveInputs)('matches RGBA hashes for sampled groups', () => {
    const rom = new Rom(new Uint8Array(readFileSync(romPath)));
    const expected: Record<string, string> = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const { groups, palettes } = extractSprites(rom);
    const byId = new Map(groups.map((g) => [g.meta.id, g]));

    for (const [id, hash] of Object.entries(expected)) {
      const g = byId.get(Number(id))!;
      const rgba = renderSpriteImage(g.pixels, palettes[g.meta.palette]);
      expect(md5(rgba), `group ${id}`).toBe(hash);
    }
  });
});
