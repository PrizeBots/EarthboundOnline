// EntityPropsForm — the SHARED per-instance property editor. Renders one numeric
// field per shared EntityProps key, where BLANK = inherited (the placeholder
// shows the inherited value) and a typed value writes a sparse override. A ✕
// resets a field back to inherited. The component is self-contained: callers feed
// it a context (kind + inherited baseline + current sparse override) via update()
// and receive sparse patches via onChange.
//
// Used by the Placement tool for per-instance overrides; the same shape/cascade
// the Entity Manager (sprite-group layer) and Enemy Spawner (spawner layer) edit,
// so they can adopt this component later for one consistent control set.
import type { EntityProps, EntityPropsOverride } from '../../engine/EntityStats';
import type { NPCKind } from '../../engine/NPC';

export type FieldKey = Exclude<keyof EntityProps, 'col' | 'combat'>;

export interface PropFieldDesc {
  key: FieldKey;
  label: string;
  min: number;
  max?: number;
  /** Display value = stored/scale (e.g. 1000 to show a ms field in seconds). */
  scale?: number;
  /** Keep fractional precision (e.g. speed); else the value is rounded. */
  float?: boolean;
  /** Entity kinds this field is meaningful for; absent = always show (used by the
   *  sprite-group / spawner / vehicle forms, which aren't per-placement-kind). */
  kinds?: NPCKind[];
}

// ONE source of label/clamp metadata for every shared prop. Each editor picks
// the ordered subset it needs via `fields()`. KEEP labels/clamps consistent here
// rather than re-declaring them per tool.
interface FieldMeta {
  label: string;
  min: number;
  max?: number;
  scale?: number;
  float?: boolean;
}
const FIELD_META: Record<FieldKey, FieldMeta> = {
  hp: { label: 'HP', min: 1 },
  level: { label: 'level', min: 1 },
  xp: { label: 'XP', min: 0 },
  damage: { label: 'damage', min: 0 },
  attackCooldownMs: { label: 'atk cd s', min: 50, scale: 1000 },
  speed: { label: 'speed', min: 0.1, float: true },
  attackRange: { label: 'atk px', min: 1 },
  detectRange: { label: 'aggro px', min: 1 },
  giveUpRange: { label: 'chase px', min: 1 },
  wanderRadius: { label: 'roam px', min: 0 },
  crit: { label: 'crit %', min: 0, max: 100 },
  dodge: { label: 'dodge %', min: 0, max: 100 },
};

/** Build an ordered field list from keys, with optional per-key `kinds` filters. */
export function fields(
  keys: FieldKey[],
  kinds?: Partial<Record<FieldKey, NPCKind[]>>
): PropFieldDesc[] {
  return keys.map((k) => ({ key: k, ...FIELD_META[k], kinds: kinds?.[k] }));
}

const COMBAT_KEYS: FieldKey[] = [
  'hp',
  'level',
  'xp',
  'damage',
  'attackCooldownMs',
  'speed',
  'attackRange',
  'crit',
  'dodge',
];
const BEHAVIOR_KEYS: FieldKey[] = ['detectRange', 'giveUpRange', 'wanderRadius'];

/** Sprite-group layer (Entity Manager): combat stats only. Aggro/chase/roam are
 *  NOT here — those are per-instance / per-spawner. */
export const ENTITY_STAT_FIELDS = fields(COMBAT_KEYS);

/** Spawner instance-override layer (Enemy Spawner): the combat fields the server's
 *  resolveProps actually honors per-spawner. Excludes crit/dodge (resolveProps
 *  ignores them at the instance layer) and the behavior ranges (the spawner has
 *  its own dedicated roam/aggro/chase inputs). KEEP IN SYNC with npcSim
 *  resolveProps' pick() set. */
export const SPAWNER_STAT_FIELDS = fields([
  'hp',
  'level',
  'xp',
  'damage',
  'attackCooldownMs',
  'speed',
  'attackRange',
]);

/** Per-instance placement override (Placement tool): combat + behavior, filtered
 *  by kind (a townsperson can only take a speed override; an enemy takes all). */
export const PLACEMENT_PROP_FIELDS = fields([...COMBAT_KEYS, ...BEHAVIOR_KEYS], {
  hp: ['enemy'],
  level: ['enemy'],
  xp: ['enemy'],
  damage: ['enemy'],
  attackCooldownMs: ['enemy'],
  speed: ['enemy', 'person'],
  attackRange: ['enemy'],
  detectRange: ['enemy'],
  giveUpRange: ['enemy'],
  wanderRadius: ['enemy'],
  crit: ['enemy'],
  dodge: ['enemy'],
});

/** Vehicle layer (Traffic Editor): the shared fields a car uses. */
export const VEHICLE_PROP_FIELDS = fields(['hp', 'damage', 'speed']);

export interface PropsFormCtx {
  kind: NPCKind;
  /** Inherited values (sprite-group + kind) — shown as greyed placeholders. */
  baseline: EntityProps;
  /** The current per-instance override (sparse). */
  override: EntityPropsOverride;
}

export class EntityPropsForm {
  readonly el: HTMLDivElement;
  private fields: PropFieldDesc[];
  private onChange: (key: PropFieldDesc['key'], value: number | undefined) => void;

  constructor(opts: {
    fields?: PropFieldDesc[];
    /** value === undefined clears the field (reverts to inherited). */
    onChange: (key: PropFieldDesc['key'], value: number | undefined) => void;
  }) {
    this.fields = opts.fields ?? PLACEMENT_PROP_FIELDS;
    this.onChange = opts.onChange;
    this.el = document.createElement('div');
    this.el.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
  }

  /** Render rows for a context, or hide entirely (null = no/unsupported selection). */
  update(ctx: PropsFormCtx | null): void {
    this.el.innerHTML = '';
    const shown = ctx ? this.fields.filter((f) => !f.kinds || f.kinds.includes(ctx.kind)) : [];
    if (!ctx || !shown.length) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = 'flex';

    const head = document.createElement('div');
    head.textContent = 'properties (blank = inherited)';
    head.style.cssText =
      'margin-top:4px;color:#b06de8;font-size:10px;letter-spacing:1px;' +
      'border-top:1px solid #2a3540;padding-top:5px;';
    this.el.appendChild(head);

    for (const f of shown) {
      const inherited = ctx.baseline[f.key] as number | undefined;
      const overridden = ctx.override[f.key] as number | undefined;
      const isSet = overridden != null;
      const fmt = (n: number) => (f.scale ? String(n / f.scale) : String(n));

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;';

      const label = document.createElement('span');
      label.textContent = f.label;
      label.style.cssText = `flex:1;font-size:11px;color:${isSet ? '#e8a33d' : '#9fb8cc'};`;
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'text';
      input.value = isSet ? fmt(overridden as number) : '';
      input.placeholder = inherited != null ? fmt(inherited) : '—';
      input.style.cssText =
        'width:64px;font:11px monospace;background:#0c1014;color:#cde;' +
        'border:1px solid #3a4a5a;border-radius:3px;padding:2px 5px;';
      input.onchange = () => {
        const raw = input.value.trim();
        if (raw === '') {
          this.onChange(f.key, undefined);
          return;
        }
        let n = parseFloat(raw);
        if (Number.isNaN(n)) return;
        n = f.scale ? Math.round(n * f.scale) : f.float ? n : Math.round(n);
        n = Math.max(f.min, n);
        if (f.max != null) n = Math.min(f.max, n);
        this.onChange(f.key, n);
      };
      row.appendChild(input);

      const reset = document.createElement('button');
      reset.textContent = '✕';
      reset.title = 'reset to inherited';
      reset.style.cssText =
        `visibility:${isSet ? 'visible' : 'hidden'};border:none;background:none;` +
        'color:#c66;cursor:pointer;font-size:11px;padding:0 2px;';
      reset.onclick = () => this.onChange(f.key, undefined);
      row.appendChild(reset);

      this.el.appendChild(row);
    }
  }
}
