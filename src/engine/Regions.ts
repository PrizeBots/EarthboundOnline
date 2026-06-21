import { getSectorForTile } from './MapManager';
import { TILE_SIZE } from '../types';

// Named world regions — the single source of truth for "which town/area is this
// world point in?". Used by the Location nav (Places tree) and the Enemy Spawner
// list's by-area grouping. Pure index/coordinate metadata, no ROM pixels.
//
// Only the 6 "Town Map Image" towns are tagged per-sector in the ROM (sectors.json
// `town`); every other area (Winters, Dalaam, the desert…) is placed by
// EarthBound's PSI-teleport destination table — authentic ROM names + coords
// (eb_project/psi_teleport_dest_table.yml). Coords are in 8px units; tile = coord/4.
// The 6 town anchors reuse the ROM `town` keys so they merge with the per-sector
// labels; the rest introduce new keys. Any point not inside a ROM town is grouped
// by its NEAREST anchor — a clean Voronoi partition grounded in real teleport
// centers (door-stitched regions are spatially separated, so nearest-anchor is
// reliable for everything the ROM doesn't tag).

export interface RegionAnchor {
  key: string;
  tx: number; // tile coord
  ty: number;
}

export const REGION_ANCHORS: RegionAnchor[] = [
  { key: 'onett', tx: 63, ty: 46 },
  { key: 'twoson', tx: 44, ty: 205 },
  { key: 'threed', tx: 173, ty: 281 },
  { key: 'dusty', tx: 40, ty: 312 },
  { key: 'saturn', tx: 8, ty: 243 },
  { key: 'fourside', tx: 95, ty: 126 },
  { key: 'winters', tx: 15, ty: 72 },
  { key: 'summers', tx: 138, ty: 88 },
  { key: 'dalaam', tx: 142, ty: 112 },
  { key: 'scaraba', tx: 38, ty: 131 },
  { key: 'deepdark', tx: 176, ty: 224 },
  { key: 'tenda', tx: 141, ty: 222 },
  { key: 'underworld', tx: 81, ty: 87 },
];

// Display order (rough EB story progression). 'other' sorts last.
export const REGION_ORDER: string[] = REGION_ANCHORS.map((a) => a.key);

export const REGION_LABEL: Record<string, string> = {
  onett: 'Onett',
  twoson: 'Twoson',
  threed: 'Threed',
  dusty: 'Dusty Dunes',
  saturn: 'Saturn Valley',
  fourside: 'Fourside',
  winters: 'Winters',
  summers: 'Summers',
  dalaam: 'Dalaam',
  scaraba: 'Scaraba',
  deepdark: 'Deep Darkness',
  tenda: 'Tenda Village',
  underworld: 'Lost Underworld',
  other: 'Other / Interiors',
};

/** The sector at a world-pixel point (null off-map / before the map loads). */
export function sectorAtPx(px: number, py: number) {
  return getSectorForTile(Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE));
}

/**
 * Region key a world point belongs to: the ROM `town` label when present (the 6
 * Town Map Image towns, authoritative), otherwise the nearest PSI-teleport
 * anchor, else 'other'.
 */
export function regionAt(px: number, py: number): string {
  const s = sectorAtPx(px, py);
  if (s?.town) return s.town;
  const tx = Math.floor(px / TILE_SIZE);
  const ty = Math.floor(py / TILE_SIZE);
  let best = 'other';
  let bd = Infinity;
  for (const a of REGION_ANCHORS) {
    const d = (tx - a.tx) ** 2 + (ty - a.ty) ** 2;
    if (d < bd) {
      bd = d;
      best = a.key;
    }
  }
  return best;
}

/** Pretty label for a region key (falls back to the raw key). */
export function regionLabel(key: string): string {
  return REGION_LABEL[key] ?? key;
}

/** Sort comparator for region keys by story order; 'other' last, unknowns after. */
export function regionOrder(key: string): number {
  const i = REGION_ORDER.indexOf(key);
  return i === -1 ? REGION_ORDER.length + (key === 'other' ? 1 : 0) : i;
}
