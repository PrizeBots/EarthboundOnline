"""
analyze_enemy_actions.py — READ-ONLY survey of EarthBound battle actions to find
which ones inflict a status, so we can configure enemies from canon (not memory).

The ROM does NOT store "poison at 30%" as a field — a battle action's effect lives
in ASM at its `Code Address`. But two recoverable signals let us classify canon:
  1. Actions sharing a Code Address share the SAME effect routine (cluster by it).
  2. The action's `Text Address` resolves to its battle message, whose wording
     usually names the effect ("scattered some spores!" = mushroomize).
Plus PSI actions cross-map through psi_ability_table.yml.

This script prints, per Code-Address cluster, the action type + a sample battle
message + which enemies use it — so a human can confirm the action→status map
before the generator (extract_enemy_afflictions.py) bakes it. Nothing is written.
"""
import os
import re
import sys
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EB = os.path.join(ROOT, "eb_project")
CCS = os.path.join(EB, "ccscript")


def load(name):
    with open(os.path.join(EB, name), "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


# --- ccscript label -> battle text -----------------------------------------
# A Text Address like "data_61.l_0xef9c30" -> file data_61.ccs, label l_0xef9c30:.
# Build one index of label -> the text lines that follow it (until the next label).
LABEL_RE = re.compile(r"^(l_0x[0-9a-fA-F]+):")
QUOTE_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')


def build_text_index():
    idx = {}
    for fn in os.listdir(CCS):
        if not fn.endswith(".ccs"):
            continue
        path = os.path.join(CCS, fn)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        cur = None
        buf = []
        for ln in lines:
            m = LABEL_RE.match(ln.strip())
            if m:
                if cur:
                    idx[cur] = " ".join(buf).strip()
                cur = m.group(1)
                buf = []
            elif cur:
                for q in QUOTE_RE.findall(ln):
                    buf.append(q)
        if cur:
            idx[cur] = " ".join(buf).strip()
    return idx


def resolve_text(addr, idx):
    # "data_61.l_0xef9c30" -> label "l_0xef9c30"
    if not isinstance(addr, str) or "." not in addr:
        return ""
    label = addr.split(".", 1)[1]
    return idx.get(label, "")


# --- status keyword classifier (battle message -> our status id) ------------
# Ordered; first hit wins. Tuned to EB battle vocabulary. LOW-confidence hits are
# still printed so a human can veto them.
STATUS_KEYWORDS = [
    ("strange", [r"spore", r"mold", r"mushroom", r"feel(s|ing)? strange", r"strange beam"]),
    ("diamond", [r"solidif", r"diamond", r"crystal", r"turn(ed)? to stone", r"petrif"]),
    ("paralysis", [r"poison sting", r"numbs", r"paraly", r"immobil"]),
    ("sleep", [r"lullaby", r"hypnos", r"put .* to sleep", r"sleep-induc", r"drowsy"]),
    ("poison", [r"poison", r"venom", r"toxic"]),
    ("nauseous", [r"nause", r"nauseat", r"queasy", r"vomit", r"blew .* breath"]),
    ("sunstroke", [r"sunstroke", r"sun ?stroke", r"heat.?stroke"]),
    ("cold", [r"caught a cold", r"hacking cough", r"sniffl"]),
    ("crying", [r"burst into tears", r"started crying", r"made .* cry"]),
    ("noPsi", [r"can'?t concentrate", r"cannot concentrate", r"lost .* concentrat"]),
    ("possessed", [r"possess", r"took control"]),
    ("mirror", [r"mirror", r"copie"]),
]


def classify_text(text):
    low = text.lower()
    hits = []
    for status, pats in STATUS_KEYWORDS:
        for p in pats:
            if re.search(p, low):
                hits.append(status)
                break
    return hits


# --- PSI action -> status (canon assist PSI) --------------------------------
# psi_ability_table maps an Action id -> PSI. The status-inflicting enemy PSI are
# Paralysis, Hypnosis (sleep), Brainshock (strange). Offense PSI (fire/freeze/etc.)
# deal damage only. We match by PSI NAME text where resolvable, else leave to text.
def main():
    actions = load("battle_action_table.yml")
    enemies = load("enemy_configuration_table.yml")
    idx = build_text_index()

    # action id -> list of enemy names that use it (any of the 5 slots)
    used_by = {}
    for cid, cfg in enemies.items():
        name = cfg.get("Name")
        if not name or name in ("null", "null "):
            continue
        for slot in ("Action 1", "Action 2", "Action 3", "Action 4", "Final Action"):
            a = cfg.get(slot, 0)
            if a:
                used_by.setdefault(int(a), set()).add(str(name))

    # Cluster actions by (Code Address) and classify by text. Only actions an
    # enemy ACTUALLY uses (used_by>0) — a used_by=0 hit is the system status
    # CONFIRMATION message ("body is numb"), not an enemy attack action.
    print("=== STATUS-INFLICTING ACTION CANDIDATES (enemy-used, by text) ===\n")
    seen_status_actions = {}
    for aid, a in actions.items():
        if not isinstance(a, dict):
            continue
        n_users = len(used_by.get(int(aid), ()))
        if n_users == 0:
            continue
        atype = a.get("Action type", "")
        code = a.get("Code Address", "")
        text = resolve_text(a.get("Text Address", ""), idx)
        statuses = classify_text(text)
        if not statuses:
            continue
        seen_status_actions[int(aid)] = (statuses, atype, code, text, n_users)

    # Enemy PSI: list every psi-type action an enemy uses so status PSI
    # (Paralysis/Hypnosis/Brainshock) is visible even when its text is the PSI name.
    print("=== ENEMY-USED PSI ACTIONS (for status-PSI mapping) ===")
    for aid, a in sorted(actions.items(), key=lambda kv: int(kv[0])):
        if not isinstance(a, dict) or a.get("Action type") != "psi":
            continue
        n = len(used_by.get(int(aid), ()))
        if n == 0:
            continue
        t = resolve_text(a.get("Text Address", ""), idx)[:60]
        who = ", ".join(sorted(used_by.get(int(aid), ()))[:4])
        print(f"  act {aid:>3} pp={a.get('PP Cost'):<3} tgt={str(a.get('Target')):<4} {a.get('Code Address')} used={n:<2} “{t}”  <- {who}")
    print()

    # Print grouped by inferred status.
    by_status = {}
    for aid, (statuses, atype, code, text, n) in seen_status_actions.items():
        for s in statuses:
            by_status.setdefault(s, []).append((aid, atype, code, text, n))
    for status in sorted(by_status):
        print(f"--- {status} ---")
        for aid, atype, code, text, n in sorted(by_status[status], key=lambda r: -r[4]):
            snip = (text[:70] + "…") if len(text) > 70 else text
            print(f"  action {aid:>3} [{atype:<9}] {code}  used_by={n:<3}  “{snip}”")
        print()

    print(f"Total actions: {len(actions)}  |  status-candidate actions: {len(seen_status_actions)}")

    # Full audit: EVERY enemy-used 'other' action + its battle text, so a human can
    # eyeball status attacks the keyword pass missed (diamond/crying/etc.).
    print("\n=== ALL enemy-used 'other' actions (audit) ===")
    for aid, a in sorted(actions.items(), key=lambda kv: int(kv[0])):
        if not isinstance(a, dict) or a.get("Action type") != "other":
            continue
        n = len(used_by.get(int(aid), ()))
        if n == 0:
            continue
        t = resolve_text(a.get("Text Address", ""), idx).replace("\n", " ")
        t = re.sub(r"\{[^}]*\}|\[[^\]]*\]", "", t)[:72]  # strip codes for readability
        print(f"  act {aid:>3} {a.get('Code Address')} used={n:<2} “{t}”")


if __name__ == "__main__":
    main()
