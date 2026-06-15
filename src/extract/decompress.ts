/**
 * EarthBound / HAL "exhal" decompression — the foundational primitive of the
 * client-side ROM extraction pipeline (see TODO.md "Pre-Launch", ARCHITECTURE).
 *
 * Faithful TypeScript port of `unpack()` from exhal/inhal (Devin Acker, MIT) —
 * the same routine CoilSnake calls natively (`native_comp.decomp`). Every ROM
 * asset (tilesets, sprites, etc.) is stored in this format, so everything reads
 * through here. We only need DEcompression: we read the player's ROM, never
 * write it.
 *
 * Parity: `src/extract/decompress.test.ts` asserts byte-for-byte equality with
 * the native CoilSnake output on real ROM blocks (fixtures dumped by
 * `tools/dump_decomp_fixtures.py`; ROM-derived, gitignored, never shipped).
 */

const DATA_SIZE = 65536; // max decompressed size (64kb), matches the C reference

/** Reverse the bit order of a byte (backref method 5). */
function rotate(i: number): number {
  let j = 0;
  if (i & 0x01) j |= 0x80;
  if (i & 0x02) j |= 0x40;
  if (i & 0x04) j |= 0x20;
  if (i & 0x08) j |= 0x10;
  if (i & 0x10) j |= 0x08;
  if (i & 0x20) j |= 0x04;
  if (i & 0x40) j |= 0x02;
  if (i & 0x80) j |= 0x01;
  return j;
}

/**
 * Decompress an EB-compressed block.
 * @param packed full ROM/data buffer
 * @param offset byte offset where the compressed block begins (CoilSnake `cdata`)
 * @returns the decompressed bytes
 * @throws if the data is malformed (overruns the 64kb window / runs off the end)
 */
export function decompress(packed: Uint8Array, offset = 0): Uint8Array {
  const unpacked = new Uint8Array(DATA_SIZE);
  let inpos = offset;
  let outpos = 0;

  for (;;) {
    if (inpos >= packed.length) {
      throw new Error('eb decompress: ran off the end of input (missing 0xFF terminator)');
    }
    const input = packed[inpos++];

    // command 0xFF = end of data
    if (input === 0xff) break;

    let command: number;
    let length: number;
    // long command (0b111xxxxx) vs regular command
    if ((input & 0xe0) === 0xe0) {
      command = (input >> 2) & 0x07;
      length = (((input & 0x03) << 8) | packed[inpos++]) + 1;
    } else {
      command = input >> 5;
      length = (input & 0x1f) + 1;
    }

    // refuse to decompress past the 64kb window (matches the C bounds check)
    if ((command === 2 && outpos + 2 * length > DATA_SIZE) || outpos + length > DATA_SIZE) {
      throw new Error('eb decompress: output would exceed 64kb (corrupt data)');
    }

    switch (command) {
      // 0: write uncompressed bytes
      case 0:
        for (let i = 0; i < length; i++) unpacked[outpos++] = packed[inpos++];
        break;

      // 1: 8-bit RLE
      case 1: {
        const b = packed[inpos++];
        for (let i = 0; i < length; i++) unpacked[outpos++] = b;
        break;
      }

      // 2: 16-bit RLE
      case 2: {
        const lo = packed[inpos];
        const hi = packed[inpos + 1];
        inpos += 2;
        for (let i = 0; i < length; i++) {
          unpacked[outpos++] = lo;
          unpacked[outpos++] = hi;
        }
        break;
      }

      // 3: 8-bit increasing sequence
      case 3: {
        const b = packed[inpos++];
        for (let i = 0; i < length; i++) unpacked[outpos++] = (b + i) & 0xff;
        break;
      }

      // 4 (and 7, a decoder quirk): normal backref, big-endian offset
      case 4:
      case 7: {
        const refOffset = (packed[inpos] << 8) | packed[inpos + 1];
        inpos += 2;
        for (let i = 0; i < length; i++) unpacked[outpos++] = unpacked[refOffset + i];
        break;
      }

      // 5: backref with bit rotation, big-endian offset
      case 5: {
        const refOffset = (packed[inpos] << 8) | packed[inpos + 1];
        inpos += 2;
        for (let i = 0; i < length; i++) unpacked[outpos++] = rotate(unpacked[refOffset + i]);
        break;
      }

      // 6: backwards backref, big-endian offset
      case 6: {
        const refOffset = (packed[inpos] << 8) | packed[inpos + 1];
        inpos += 2;
        for (let i = 0; i < length; i++) unpacked[outpos++] = unpacked[refOffset - i];
        break;
      }
    }
  }

  return unpacked.subarray(0, outpos);
}
