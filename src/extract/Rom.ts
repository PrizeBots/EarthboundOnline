/**
 * ROM container for the client-side extraction pipeline — the byte-level base
 * the rest of the TS extractors read through. Mirrors the slice of CoilSnake's
 * `Rom`/`Block` + `util.eb.pointer` we actually use (little-endian multi-byte
 * reads, SNES↔file address mapping, fixed-width table reads).
 *
 * A clean unheadered EarthBound ROM is exactly 0x300000 bytes. We strip a 0x200
 * copier header if present; deeper validation (checksum-verify known dumps) is
 * the job of the ROM intake screen, not this reader.
 */

export const EB_CLEAN_SIZE = 0x300000;

/** SNES (HiROM) address → file offset, matching `from_snes_address`. */
export function fromSnesAddress(address: number): number {
  if (address < 0) throw new Error(`Invalid snes address ${address.toString(16)}`);
  return address >= 0xc00000 ? address - 0xc00000 : address;
}

export class Rom {
  readonly data: Uint8Array;

  constructor(bytes: Uint8Array) {
    // Strip a 0x200-byte SMC copier header if one is present (file length is a
    // multiple of 0x400 plus the 0x200 header).
    if (bytes.length % 0x400 === 0x200) {
      bytes = bytes.subarray(0x200);
    }
    this.data = bytes;
  }

  get size(): number {
    return this.data.length;
  }

  /** Single byte at a raw file offset. */
  byte(offset: number): number {
    return this.data[offset];
  }

  /**
   * Read a little-endian multi-byte integer at a raw file offset.
   * Mirrors `Block.read_multi`.
   */
  readMulti(offset: number, size: number): number {
    if (size < 0) throw new Error(`negative read length ${size}`);
    if (size === 0) return 0;
    if (offset < 0 || offset + size > this.size) {
      throw new Error(`read of ${size} @ ${offset.toString(16)} out of bounds`);
    }
    let out = 0;
    for (let i = 0; i < size; i++) {
      // multiply instead of <<: a 4-byte pointer can exceed 31 bits, where the
      // bitwise << would wrap to a negative number.
      out += this.data[offset + i] * 2 ** (8 * i);
    }
    return out;
  }

  /**
   * Read a fixed-width table of integers given a SNES address. Each of the
   * `rows` entries is `entryBytes` little-endian bytes. Pointer tables use
   * entryBytes=4; small value tables (e.g. map-tileset→draw-tileset) use 1.
   * Equivalent to reading `table[i][0]` for every row of a CoilSnake table.
   */
  readTable(snesAddr: number, rows: number, entryBytes = 4): number[] {
    const base = fromSnesAddress(snesAddr);
    const out: number[] = new Array(rows);
    for (let i = 0; i < rows; i++) {
      out[i] = this.readMulti(base + i * entryBytes, entryBytes);
    }
    return out;
  }
}
