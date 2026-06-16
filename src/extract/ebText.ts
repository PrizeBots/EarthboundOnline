/**
 * EarthBound text byte-decoder — a TypeScript port of CCScriptWriter's text
 * reader (Lyrositor/CCScriptWriter), which is the tool that produced this
 * project's `eb_project/ccscript` dump. The main dialogue lives in the ROM as a
 * control-code byte stream; this reads one block (starting at a SNES text
 * pointer) into a token list the dialogue decoder walks.
 *
 * Characters are stored as `byte - 0x30`. Bytes 0x00–0x30 are control codes
 * whose operand length is fixed (CONTROL_CODES) or computed (getLength). A block
 * ends at 0x02 or 0x0A (with a quirk: a 0x19 menu code expects a trailing 0x02
 * that does NOT end the block). Embedded 4-byte LE pointers (in 0x06/0x08/0x0A)
 * are how the script graph links.
 */
import { Rom } from './Rom';

// Operand byte length for control codes 0x00–0x30. null = variable (getLength).
const CONTROL_CODES: Record<number, number | null> = {
  0x00: 0,
  0x01: 0,
  0x02: 0,
  0x03: 0,
  0x04: 2,
  0x05: 2,
  0x06: 6,
  0x07: 2,
  0x08: 4,
  0x09: null,
  0x0a: 4,
  0x0b: 1,
  0x0c: 1,
  0x0d: 1,
  0x0e: 1,
  0x0f: 0,
  0x10: 1,
  0x11: 0,
  0x12: 0,
  0x13: 0,
  0x14: 0,
  0x15: 1,
  0x16: 1,
  0x17: 1,
  0x18: null,
  0x19: null,
  0x1a: null,
  0x1b: null,
  0x1c: null,
  0x1d: null,
  0x1e: null,
  0x1f: null,
  0x20: 0,
  0x21: 0,
  0x22: 0,
  0x23: 0,
  0x24: 0,
  0x25: 0,
  0x26: 0,
  0x27: 0,
  0x28: 0,
  0x29: 0,
  0x2a: 0,
  0x2b: 0,
  0x2c: 0,
  0x2d: 0,
  0x2e: 0,
  0x2f: 0,
  0x30: 0,
};

const COMBOS_1F: Record<number, number | null> = {
  0x00: 3,
  0x01: 2,
  0x02: 2,
  0x03: 1,
  0x04: 2,
  0x05: 1,
  0x06: 1,
  0x07: 2,
  0x11: 2,
  0x12: 2,
  0x13: 3,
  0x14: 2,
  0x15: 6,
  0x16: 4,
  0x17: 6,
  0x18: 8,
  0x19: 8,
  0x1a: 4,
  0x1b: 3,
  0x1c: 3,
  0x1d: 2,
  0x1e: 4,
  0x1f: 4,
  0x20: 3,
  0x21: 2,
  0x23: 3,
  0x30: 1,
  0x31: 1,
  0x41: 2,
  0x50: 1,
  0x51: 1,
  0x52: 2,
  0x60: 2,
  0x61: 1,
  0x62: 2,
  0x63: 5,
  0x64: 1,
  0x65: 1,
  0x66: 7,
  0x67: 2,
  0x68: 1,
  0x69: 1,
  0x71: 3,
  0x81: 3,
  0x83: 3,
  0x90: 1,
  0xa0: 1,
  0xa1: 1,
  0xa2: 1,
  0xb0: 1,
  0xc0: null,
  0xd0: 2,
  0xd1: 1,
  0xd2: 2,
  0xd3: 2,
  0xe1: 4,
  0xe4: 4,
  0xe5: 2,
  0xe6: 3,
  0xe7: 3,
  0xe8: 2,
  0xe9: 3,
  0xea: 3,
  0xeb: 3,
  0xec: 3,
  0xed: 1,
  0xee: 3,
  0xef: 3,
  0xf0: 1,
  0xf1: 5,
  0xf2: 5,
  0xf3: 4,
  0xf4: 3,
};
const COMBOS_18: Record<number, number> = {
  0x00: 1,
  0x01: 2,
  0x02: 1,
  0x03: 2,
  0x04: 1,
  0x05: 3,
  0x06: 1,
  0x07: 6,
  0x08: 2,
  0x09: 2,
  0x0a: 1,
  0x0d: 3,
};
const COMBOS_19: Record<number, number> = {
  0x02: 1,
  0x04: 1,
  0x05: 4,
  0x10: 2,
  0x11: 2,
  0x14: 1,
  0x16: 3,
  0x18: 2,
  0x19: 3,
  0x1a: 2,
  0x1b: 2,
  0x1c: 3,
  0x1d: 3,
  0x1e: 1,
  0x1f: 1,
  0x20: 1,
  0x21: 2,
  0x22: 5,
  0x23: 6,
  0x24: 6,
  0x25: 2,
  0x26: 2,
  0x27: 2,
  0x28: 2,
};
const COMBOS_1A: Record<number, number> = {
  0x00: 18,
  0x01: 18,
  0x04: 1,
  0x05: 3,
  0x06: 2,
  0x07: 1,
  0x08: 1,
  0x09: 1,
  0x0a: 1,
  0x0b: 1,
};
const COMBOS_1C: Record<number, number> = {
  0x00: 2,
  0x01: 2,
  0x02: 2,
  0x03: 2,
  0x04: 1,
  0x05: 2,
  0x06: 2,
  0x07: 2,
  0x08: 2,
  0x09: 1,
  0x0a: 5,
  0x0b: 5,
  0x0c: 2,
  0x0d: 1,
  0x0e: 1,
  0x0f: 1,
  0x11: 2,
  0x12: 2,
  0x13: 3,
  0x14: 2,
  0x15: 2,
};
const COMBOS_1D: Record<number, number> = {
  0x00: 3,
  0x01: 3,
  0x02: 2,
  0x03: 2,
  0x04: 3,
  0x05: 3,
  0x06: 5,
  0x07: 5,
  0x08: 3,
  0x09: 3,
  0x0a: 2,
  0x0b: 2,
  0x0c: 3,
  0x0d: 4,
  0x0e: 3,
  0x0f: 3,
  0x10: 3,
  0x11: 3,
  0x12: 3,
  0x13: 3,
  0x14: 5,
  0x15: 3,
  0x17: 5,
  0x18: 2,
  0x19: 2,
  0x20: 1,
  0x21: 2,
  0x22: 1,
  0x23: 2,
  0x24: 2,
};

/**
 * Operand length of a variable control code. `data[i-1]` is the code byte;
 * `data[i]` is its first sub-byte. Mirrors CCScriptWriter.getLength.
 */
function getLength(data: Uint8Array, i: number): number {
  const c = data[i - 1];
  const sub = data[i];
  if (c === 0x09) return 1 + sub * 4;
  if (c === 0x1b) return sub === 0x02 || sub === 0x03 ? 5 : 1;
  if (c === 0x1e) return sub === 0x09 ? 5 : 3;
  if (c === 0x1f) {
    if (sub !== 0xc0) return COMBOS_1F[sub] ?? 0;
    return 2 + data[i + 1] * 4;
  }
  const table =
    c === 0x18
      ? COMBOS_18
      : c === 0x19
        ? COMBOS_19
        : c === 0x1a
          ? COMBOS_1A
          : c === 0x1c
            ? COMBOS_1C
            : c === 0x1d
              ? COMBOS_1D
              : null;
  return table ? (table[sub] ?? 0) : 0;
}

export type TextToken =
  | { kind: 'char'; ch: string }
  | { kind: 'code'; op: number; operand: number[] };

const SPECIAL_CHAR_CODES = new Set([0x52, 0x8b, 0x8c, 0x8d]);

/** Read 4 operand bytes as a little-endian SNES address. */
export function operandPointer(operand: number[], offset = 0): number {
  return (
    (operand[offset] |
      (operand[offset + 1] << 8) |
      (operand[offset + 2] << 16) |
      (operand[offset + 3] << 24)) >>>
    0
  );
}

/**
 * Decode the block starting at file `offset` into tokens, stopping after the
 * block-ending control code (0x02 / 0x0A). Mirrors CCScriptWriter.getText with
 * dataType=0 (normal dialogue blocks).
 */
export function readBlock(rom: Rom, offset: number): TextToken[] {
  const data = rom.data;
  const tokens: TextToken[] = [];
  let i = offset;
  let expect02 = false; // a 0x19 menu code expects a trailing 0x02 mid-block

  for (;;) {
    const c = data[i++];
    if (c <= 0x30) {
      const fixed = CONTROL_CODES[c];
      const length = typeof fixed === 'number' ? fixed : getLength(data, i);
      const operand: number[] = [];
      for (let k = 0; k < length; k++) operand.push(data[i++]);
      tokens.push({ kind: 'code', op: c, operand });

      if (c === 0x19) expect02 = true;
      if (c === 0x02 && expect02) {
        expect02 = false;
      } else if (c === 0x02 || c === 0x0a) {
        break;
      }
    } else if (SPECIAL_CHAR_CODES.has(c)) {
      tokens.push({ kind: 'code', op: c, operand: [] });
    } else {
      tokens.push({ kind: 'char', ch: String.fromCharCode(c - 0x30) });
    }
    // Safety: never run off the ROM on malformed data.
    if (i >= data.length) break;
  }
  return tokens;
}
