"""
extract_shops.py — build public/assets/map/shops.json from the CoilSnake project.

EarthBound shops: a clerk NPC's Text Pointer 1 runs a script that does
`{set(flag N)} call(<shop routine>)`. The shop ASM then picks the store from
which flag is set. The store index into store_table is `flag - 225` (flags 224
/225 are the buy/sell MODE markers; the store-selector flags start at 226, and
store_table[0] is the null store — verified against the Onett drug store:
NPC 9 -> flag 226 -> store 1 (Cracked bat, Tee ball bat, ...), NPC 8 -> flag 227
-> store 2 (Cold remedy)).

Output (OUR authored metadata — pure ids/prices, no ROM pixels):
  {
    "items":    { "<id>": {"name": str, "cost": int, "type": int}, ... },
    "stores":   { "<storeId>": [itemId, ...], ... },
    "npcShops": { "<npcId>": {"store": int, "mode": "buysell"|"buy"}, ... }
  }
Mirrors the clerk-flag tracing the engine does at runtime, but baked once here so
neither server nor client has to parse ccscript.
"""

import json
import os
import re
import glob
import yaml

EB = "eb_project"
OUT = "public/assets/map/shops.json"
CCS = os.path.join(EB, "ccscript")

FLAG_TO_STORE_OFFSET = 225  # storeId = set-flag - 225
BUYSELL_LABEL = "data_13.l_0xc5decb"  # shop routine offering Buy + Sell
BUY_LABEL = "data_13.l_0xc5dfb1"      # shop routine offering Buy only


def load_labels():
    """Parse every ccscript label into `module.label -> body text`."""
    labels = {}
    for fp in glob.glob(os.path.join(CCS, "*.ccs")):
        mod = os.path.basename(fp)[:-4]
        cur, buf = None, []
        with open(fp, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.match(r"^(l_0x[0-9a-f]+):", line)
                if m:
                    if cur:
                        labels[f"{mod}.{cur}"] = "".join(buf)
                    cur, buf = m.group(1), [line[m.end():]]
                elif cur is not None:
                    buf.append(line)
        if cur:
            labels[f"{mod}.{cur}"] = "".join(buf)
    return labels


def trace_shop(start, labels, depth=0, seen=None):
    """Follow call/goto chains from a clerk's Text Pointer 1 to find the
    (store flag, shop routine). Returns (flag, mode) or (None, None)."""
    seen = seen or set()
    if depth > 8 or start not in labels or start in seen:
        return None, None
    seen.add(start)
    body = labels[start]
    fm = re.search(r"set\(flag (\d+)\)", body)
    flag = int(fm.group(1)) if fm else None
    mode = "buysell" if BUYSELL_LABEL in body else ("buy" if BUY_LABEL in body else None)
    if flag and mode:
        return flag, mode
    for nxt in re.findall(r"(?:call|goto)\((data_\d+\.l_0x[0-9a-f]+)\)", body):
        f, m = trace_shop(nxt, labels, depth + 1, seen)
        flag = flag or f
        mode = mode or m
        if flag and mode:
            return flag, mode
    return flag, mode


def main():
    items_cfg = yaml.safe_load(open(os.path.join(EB, "item_configuration_table.yml")))
    stores_cfg = yaml.safe_load(open(os.path.join(EB, "store_table.yml")))
    npc_cfg = yaml.safe_load(open(os.path.join(EB, "npc_config_table.yml")))
    labels = load_labels()

    # Item catalog: every real item, so the client can name anything a player
    # holds and the server can price a sale of anything sellable. We also decode
    # the EQUIP properties from the EarthBound item Type/Argument bytes:
    #   Type 0x10-0x1F are the four equip slots — slot = (type >> 2) & 3 ->
    #   0 weapon, 1 body, 2 arms, 3 other. For weapons Argument[0] is the
    #   OFFENSE bonus; for the three armor slots Argument[0] is the DEFENSE
    #   bonus (verified: Cracked bat off+4, Tee ball +8; Cheap bracelet def+5).
    #   "Misc Flags" like "ness can use" name who may equip/use the item.
    EQUIP_SLOTS = ["weapon", "body", "arms", "other"]

    def equip_props(cfg):
        t = int(cfg.get("Type", 0) or 0)
        if not (0x10 <= t < 0x20):
            return None  # not equippable gear
        slot = EQUIP_SLOTS[(t >> 2) & 3]
        arg0 = int((cfg.get("Argument") or [0])[0] or 0)
        out = {"slot": slot}
        if slot == "weapon":
            out["offense"] = arg0
        else:
            out["defense"] = arg0
        return out

    def users_of(cfg):
        # "<char> can use" / "... can equip" Misc Flags -> ["ness", ...]
        out = []
        for f in cfg.get("Misc Flags") or []:
            w = str(f).split()
            if len(w) >= 3 and w[1] == "can":
                out.append(w[0])
        return out

    items = {}
    for iid, cfg in items_cfg.items():
        if not iid or not isinstance(cfg, dict):
            continue
        rec = {
            "name": cfg.get("Name", f"Item {iid}").strip(),
            "cost": int(cfg.get("Cost", 0) or 0),
            "type": int(cfg.get("Type", 0) or 0),
        }
        eq = equip_props(cfg)
        if eq:
            rec["equip"] = eq
        users = users_of(cfg)
        if users:
            rec["users"] = users
        items[str(iid)] = rec

    # Store inventories (drop empty slots / the null store).
    stores = {}
    for sid, cfg in stores_cfg.items():
        ids = [cfg.get(f"Item {k}", 0) for k in range(1, 8)]
        ids = [i for i in ids if i]
        if ids:
            stores[str(sid)] = ids

    # Clerk -> store, by tracing each NPC config's Text Pointer 1.
    npc_shops = {}
    traced = skipped = 0
    for nid, cfg in npc_cfg.items():
        if not isinstance(cfg, dict) or cfg.get("Type") != "person":
            continue
        tp1 = cfg.get("Text Pointer 1")
        if not isinstance(tp1, str) or not tp1.startswith("data_"):
            continue
        flag, mode = trace_shop(tp1, labels)
        if not flag or not mode:
            continue
        store = flag - FLAG_TO_STORE_OFFSET
        if str(store) not in stores:
            skipped += 1
            continue
        npc_shops[str(nid)] = {"store": store, "mode": mode}
        traced += 1

    # Content overrides (OUR fan-game decisions, applied over the ROM trace):
    #   cfg 33 = the Onett Burger Shop clerk. The ROM wires it to store 3
    #   ("Gelato de resort") even though the room is the burger shop (the NPC
    #   banter is all fries/burgers). Repoint it to store 4 (juice/coffee/fries/
    #   hamburger) so the burger shop sells burgers.
    CLERK_STORE_OVERRIDES = {"33": 4}
    for nid, store in CLERK_STORE_OVERRIDES.items():
        if str(store) in stores:
            npc_shops[nid] = {"store": store, "mode": npc_shops.get(nid, {}).get("mode", "buy")}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"items": items, "stores": stores, "npcShops": npc_shops}, f)

    print(f"Wrote {OUT}")
    print(f"  items: {len(items)}  stores: {len(stores)}  shop clerks: {traced} (skipped {skipped} off-table)")
    cookie = next((i for i, v in items.items() if v["name"].lower() == "cookie"), None)
    print(f"  Cookie item id = {cookie}")


if __name__ == "__main__":
    main()
