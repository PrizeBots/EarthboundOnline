/**
 * Dialogue extraction — reproduces `eb_dialogue.py` / `npc_text.json` directly
 * from the ROM. Reads the NPC config table for each NPC's text pointer, then
 * walks EB's text-engine byte stream (ebText.readBlock) following the script
 * graph, evaluating event flags against the open-world flag state, and emitting
 * the dialogue PAGES a text window would show.
 *
 * Port of eb_dialogue.py's _Decoder semantics over byte tokens instead of the
 * ccscript dump. Parity: `test/extract/dialogue.test.ts` vs npc_text.json.
 */
import { Rom, fromSnesAddress } from './Rom';
import { readBlock, operandPointer, type TextToken } from './ebText';

const NPC_CONFIG_TABLE = 0xcf8985;
const CONFIG_ENTRY_SIZE = 17;
const NUM_CONFIGS = 1584;
const TEXT_PTR1_OFFSET = 9;

const MAX_PAGES = 12;
const MAX_BLOCKS = 64;

// EB text compression: [15/16/17 XX] reference a dictionary entry. The pointer
// table holds 4-byte SNES pointers; bank = code-0x15 (0–2), idx = XX. Each entry
// is a null-terminated run of `byte-0x30` characters.
const COMPRESSED_TEXT_PTRS = 0x8cded;

const PARTY_NAMES: Record<number, string> = { 1: 'Ness', 2: 'Paula', 3: 'Jeff', 4: 'Poo' };
// {stat(N)} fields that print text: party names live 22 apart (8/30/52/74); 7 = bank balance.
const STAT_TEXT: Record<number, string> = { 7: '0', 8: 'Ness', 30: 'Paula', 52: 'Jeff', 74: 'Poo' };

export type DialogueContext = {
  setFlags: Set<number>;
  itemNames?: Record<number, string>;
};

/** Read each NPC config's Text Pointer 1 (SNES address; 0 = none). */
export function readNpcTextPointers(rom: Rom): Map<number, number> {
  const base = fromSnesAddress(NPC_CONFIG_TABLE);
  const out = new Map<number, number>();
  for (let id = 0; id < NUM_CONFIGS; id++) {
    const ptr = rom.readMulti(base + id * CONFIG_ENTRY_SIZE + TEXT_PTR1_OFFSET, 4);
    if (ptr !== 0) out.set(id, ptr);
  }
  return out;
}

class Decoder {
  pages: string[] = [];
  private lines: string[] = [];
  private buf = '';
  private lastResult: boolean | null = null;
  jump: number | null = null; // next SNES address to continue at
  done = false;

  constructor(
    private rom: Rom,
    private ctx: DialogueContext
  ) {}

  private flushLine(): void {
    const line = this.buf.trim();
    this.buf = '';
    if (line) this.lines.push(line);
  }
  private flushPage(): void {
    this.flushLine();
    if (this.lines.length) {
      this.pages.push(this.lines.join('\n'));
      this.lines = [];
    }
    if (this.pages.length >= MAX_PAGES) this.done = true;
  }

  private text(ch: string): void {
    if (ch === '@') this.flushLine();
    else if (ch === '<' || ch === '>')
      this.buf += '"'; // EB quote glyphs → ASCII "
    else this.buf += ch;
  }

  private code(op: number, operand: number[]): void {
    switch (op) {
      case 0x06: // jump if event flag set
        if (this.ctx.setFlags.has(operand[0] | (operand[1] << 8))) {
          this.jump = operandPointer(operand, 2);
        }
        break;
      case 0x1b: // conditional jump on the last test (sub 02/03); other 0x1B
        // sub-codes (swap, store/load registers…) are unevaluable → clear the test.
        if (operand[0] === 0x02 && this.lastResult === false)
          this.jump = operandPointer(operand, 1);
        else if (operand[0] === 0x03 && this.lastResult === true)
          this.jump = operandPointer(operand, 1);
        else this.lastResult = null;
        break;
      case 0x0a: // goto
        this.jump = operandPointer(operand, 0);
        break;
      case 0x07: // {isset(flag N)} — record the test result
        this.lastResult = this.ctx.setFlags.has(operand[0] | (operand[1] << 8));
        break;
      case 0x09: // computed jump — dialogue ends
        this.done = true;
        break;
      case 0x19: // window/menu — a [19 02] menu ends the dialogue
        if (operand[0] === 0x02) this.done = true;
        break;
      case 0x02: // end of block / dialogue
        this.done = true;
        break;
      case 0x03: // prompt + advance → new page ([03 00] = `next`)
        this.flushPage();
        break;
      // 0x13 ({wait}) and 0x14 ({prompt}) pause for input but do NOT advance the
      // page — eb_dialogue drops them (they survive as macros, not [03]).
      case 0x00:
      case 0x01: // line / new line
        this.flushLine();
        break;
      case 0x15:
      case 0x16:
      case 0x17: // compressed-text reference → expand its dictionary entry
        this.expandCompressed(op - 0x15, operand[0]);
        break;
      case 0x1c: // text-print sub-codes (names, stats, items)
        this.printCode(operand);
        break;
      // Unevaluable "test" codes (result_is/result_not/counter, c/rtoarg, inc,
      // hasitem/item-checks) clear the last result so a following [1B] falls
      // through, exactly like eb_dialogue. Everything else is presentation → dropped.
      case 0x0b:
      case 0x0c:
      case 0x0d:
      case 0x0e:
      case 0x0f:
      case 0x1d:
        this.lastResult = null;
        break;
    }
  }

  // Expand an EB text-compression reference into its decoded characters.
  private expandCompressed(bank: number, idx: number): void {
    const p = COMPRESSED_TEXT_PTRS + (bank * 0x100 + idx) * 4;
    let ptr = fromSnesAddress(this.rom.readMulti(p, 4));
    let b: number;
    while ((b = this.rom.byte(ptr)) !== 0) {
      this.text(String.fromCharCode(b - 0x30));
      ptr++;
    }
  }

  // [1C sub arg]: print character/stat/item text (matches CCScriptWriter's
  // {stat}/{name}/{itemname} macros + eb_dialogue's expansion).
  private printCode(operand: number[]): void {
    const sub = operand[0];
    const arg = operand[1];
    if (sub === 0x01) {
      this.buf += STAT_TEXT[arg] ?? ''; // {stat(arg)} — record text (party names/bank)
    } else if (sub === 0x02) {
      this.buf += PARTY_NAMES[arg] ?? 'Ness'; // {name(arg)} — party member name
    } else if (sub === 0x05) {
      this.buf += this.ctx.itemNames?.[arg] ?? 'something'; // {itemname(arg)}
    }
    // other 0x1C sub-codes ({open_hp}, {smash}, …) produce no display text.
  }

  /** Flush any pending text into a final page (called once decoding ends). */
  finish(): void {
    this.flushPage();
  }

  /** Process one block's tokens; returns the next address to jump to, or null. */
  block(tokens: TextToken[]): number | null {
    for (const t of tokens) {
      if (t.kind === 'char') this.text(t.ch);
      else this.code(t.op, t.operand);
      if (this.done) return null;
      if (this.jump !== null) {
        const j = this.jump;
        this.jump = null;
        return j;
      }
    }
    return null;
  }
}

/** Decode the dialogue at a text pointer into page strings ([] if none). */
export function decodeDialogue(rom: Rom, textPtr: number, ctx: DialogueContext): string[] {
  const d = new Decoder(rom, ctx);
  const visited = new Set<number>();
  let addr: number | null = textPtr;
  while (addr && !visited.has(addr) && visited.size < MAX_BLOCKS) {
    visited.add(addr);
    const tokens = readBlock(rom, fromSnesAddress(addr));
    addr = d.block(tokens);
    if (d.done) break;
  }
  d.finish();
  return d.pages;
}

/** Decode dialogue for a set of NPC config ids (default: all with a text pointer). */
export function extractDialogue(
  rom: Rom,
  ctx: DialogueContext,
  ids?: Iterable<number>
): Record<string, string[]> {
  const pointers = readNpcTextPointers(rom);
  const out: Record<string, string[]> = {};
  const targetIds = ids ?? pointers.keys();
  for (const id of targetIds) {
    const ptr = pointers.get(id);
    if (ptr === undefined) continue;
    const pages = decodeDialogue(rom, ptr, ctx);
    if (pages.length) out[String(id)] = pages;
  }
  return out;
}
