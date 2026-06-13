"""
eb_dialogue — decode CoilSnake ccscript text dumps into plain dialogue pages.

The CCScriptWriter dump (eb_project/ccscript/data_*.ccs) is a faithful
decompile of EarthBound's text engine bytecode: quoted strings hold literal
text interleaved with [..] raw control codes and {..} macros; bare tokens
between strings carry simple flow (next/linebreak/goto/call/end/eob).

We walk that bytecode like the game would for a player just talking:
    - [06 LL HH {e(label)}]  jump if event flag set   -> evaluated against
      the open-world flag state (src/world_flags.json), same source of truth
      as apply_map_changes.py / extract_npcs.py
    - {isset(flag N)} + [1B 02/03 {e(label)}]          -> jump if last test
      false/true; tests we can't evaluate (items, counters) fall through
    - goto / [0A] follow; call/[08] are engine subroutines (battles, gifts) —
      skipped; menus [19 02] and computed jumps [09 ..] end the dialogue
      (the text up to the question still reads naturally)
    - `next`/[03] split pages; `@` starts a new line; everything else
      (pauses, sounds, windows, flag writes) is presentation and is dropped

{name(N)} expands to the canonical party names and {itemname(N)} to names
from item_configuration_table.yml so lines read like the original game.

Output is a list of page strings (lines joined with \n) — exactly what a
text window displays between button prompts. No ROM access: the ccscript
dump and YAML tables are the only inputs.
"""
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CCS_DIR = ROOT / "eb_project" / "ccscript"

PARTY_NAMES = {1: "Ness", 2: "Paula", 3: "Jeff", 4: "Poo"}

# {stat(N)} character-record fields that print text: the four party member
# names live 22 apart (8/30/52/74); 7 is the player's bank balance.
STAT_TEXT = {7: "0", 8: "Ness", 30: "Paula", 52: "Jeff", 74: "Poo"}

MAX_PAGES = 12
MAX_BLOCKS = 64  # jump-following safety net

# ---------------------------------------------------------------- label map

_blocks = None       # qualified label -> body text
_file_order = None   # module -> [labels in file order] (for fallthrough)
_addr_to_label = None  # 0xc74c07 -> "data_28.l_0xc74c07"
_item_names = None

_LABEL_RE = re.compile(r"^(l_0x[0-9a-f]+):\s*$", re.M)


def _load():
    global _blocks, _file_order, _addr_to_label, _item_names
    if _blocks is not None:
        return
    _blocks, _file_order, _addr_to_label = {}, {}, {}
    for path in sorted(CCS_DIR.glob("data_*.ccs")):
        module = path.stem
        text = path.read_text(encoding="utf-8", errors="replace")
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
        text = re.sub(r"^command .*$", "", text, flags=re.M)
        parts = _LABEL_RE.split(text)
        # parts = [preamble, label, body, label, body, ...]
        order = []
        for i in range(1, len(parts), 2):
            label = f"{module}.{parts[i]}"
            _blocks[label] = parts[i + 1]
            _addr_to_label[int(parts[i][4:], 16)] = label
            order.append(label)
        _file_order[module] = order

    _item_names = {}
    item_table = ROOT / "eb_project" / "item_configuration_table.yml"
    if item_table.exists():
        for k, v in yaml.safe_load(item_table.read_text(encoding="utf-8")).items():
            if isinstance(v, dict) and "Name" in v:
                _item_names[int(k)] = v["Name"]


def resolve_pointer(ptr):
    """npc_config_table text pointer -> qualified label, or None.
    Accepts 'data_28.l_0xc74c07', '$0', or a raw '$c74c07' address."""
    _load()
    ptr = str(ptr).strip()
    if not ptr:
        return None
    if ptr.startswith("$"):
        addr = int(ptr[1:], 16)
        return _addr_to_label.get(addr)  # $0 and out-of-dump -> None
    return ptr if ptr in _blocks else None


# ---------------------------------------------------------------- tokenizer

# A block body is a sequence of quoted strings and bare flow tokens.
_TOKEN_RE = re.compile(r'"((?:[^"])*)"|(\w+)(?:\(([^()]*)\))?')

# Inside a string: [raw code], {macro}, or literal text.
_PART_RE = re.compile(r"\[([^\]]*)\]|\{(\w+)(?:\(([^)]*)\))?\}")

_REF_RE = re.compile(r"\{e\(([\w.]+)\)\}")


def _qualify(label, module):
    return label if "." in label else f"{module}.{label}"


class _Decoder:
    def __init__(self, set_flags):
        self.set_flags = set_flags
        self.pages = []
        self.lines = []
        self.buf = ""
        self.last_result = None  # result of last evaluable test, else None
        self.jump = None         # label to continue at
        self.done = False

    # -- output helpers --
    def _flush_line(self):
        line = self.buf.strip()
        self.buf = ""
        if line:
            self.lines.append(line)

    def _flush_page(self):
        self._flush_line()
        if self.lines:
            self.pages.append("\n".join(self.lines))
            self.lines = []
        if len(self.pages) >= MAX_PAGES:
            self.done = True

    # -- raw [..] control codes --
    def _code(self, body, module):
        refs = [_qualify(m, module) for m in _REF_RE.findall(body)]
        try:
            data = [int(b, 16) for b in _REF_RE.sub("", body).split()]
        except ValueError:
            return
        if not data:
            return
        op = data[0]
        if op == 0x06 and len(data) >= 3 and refs:
            if (data[1] | data[2] << 8) in self.set_flags:
                self.jump = refs[0]
        elif op == 0x1B and len(data) >= 2 and refs:
            if data[1] == 0x02 and self.last_result is False:
                self.jump = refs[0]
            elif data[1] == 0x03 and self.last_result is True:
                self.jump = refs[0]
        elif op == 0x0A and refs:
            self.jump = refs[0]
        elif op == 0x09 or (op == 0x19 and len(data) >= 2 and data[1] == 0x02):
            self.done = True  # menu / computed jump — dialogue ends here
        elif op == 0x02:
            self.done = True
        elif op in (0x03, 0x13):
            self._flush_page()

    # -- {..} macros --
    def _macro(self, name, args):
        if name == "isset":
            m = re.search(r"\d+", args or "")
            self.last_result = bool(m) and int(m.group()) in self.set_flags
        elif name == "name":
            m = re.search(r"\d+", args or "")
            self.buf += PARTY_NAMES.get(int(m.group()) if m else 0, "Ness")
        elif name == "itemname":
            m = re.search(r"\d+", args or "")
            self.buf += _item_names.get(int(m.group()) if m else -1, "something")
        elif name == "stat":
            m = re.search(r"\d+", args or "")
            self.buf += STAT_TEXT.get(int(m.group()) if m else -1, "")
        elif name in ("swap", "result_is", "counter", "hasitem", "delta",
                      "long", "ctoarg", "rtoarg", "inc"):
            self.last_result = None  # test we can't evaluate — fall through
        # everything else (pause, sound, windows, set/unset, ...) is dropped

    # -- one quoted string --
    def _string(self, s, module):
        pos = 0
        for m in _PART_RE.finditer(s):
            self._literal(s[pos:m.start()])
            pos = m.end()
            if self.jump or self.done:
                return
            if m.group(1) is not None:
                self._code(m.group(1), module)
            else:
                self._macro(m.group(2), m.group(3))
            if self.jump or self.done:
                return
        self._literal(s[pos:])

    def _literal(self, text):
        for ch in text:
            if ch == "@":
                self._flush_line()
            elif ch in "<>":
                # EB's font shows < > as open/close double quotes; our text
                # renderer is plain ASCII, so use a straight quote.
                self.buf += '"'
            else:
                self.buf += ch

    # -- one labeled block; returns label to continue at, or None --
    def block(self, label):
        module = label.split(".")[0]
        for m in _TOKEN_RE.finditer(_blocks[label]):
            if m.group(1) is not None:
                self._string(m.group(1), module)
            else:
                tok, arg = m.group(2), m.group(3)
                if tok == "next":
                    self._flush_page()
                elif tok in ("linebreak", "newline"):
                    self._flush_line()
                elif tok == "goto" and arg:
                    self.jump = _qualify(arg.strip(), module)
                elif tok in ("end", "eob"):
                    self.done = True
                # call(..) and anything else: engine work, skipped
            if self.done:
                return None
            if self.jump:
                jump, self.jump = self.jump, None
                return jump
        # No terminator: ccscript falls through to the next label in the file.
        order = _file_order[module]
        i = order.index(label)
        return order[i + 1] if i + 1 < len(order) else None


def decode(pointer, set_flags):
    """Decode the dialogue at a text pointer into page strings ([] if none)."""
    _load()
    label = resolve_pointer(pointer)
    d = _Decoder(set_flags)
    visited = set()
    while label and label in _blocks and label not in visited and len(visited) < MAX_BLOCKS:
        visited.add(label)
        label = d.block(label)
    d._flush_page()
    return d.pages


if __name__ == "__main__":
    import json
    flags = {
        int(f, 16)
        for f in json.load(open(ROOT / "src" / "world_flags.json"))["setFlags"]
    }
    for ptr in ("data_28.l_0xc74c07", "data_28.l_0xc74690", "data_21.l_0xc680a6"):
        print(f"--- {ptr}")
        for page in decode(ptr, flags):
            print(page)
