"""survey_enemy_psi.py — READ-ONLY: which PSI does each enemy cast, per canon.
Maps enemy action slots -> psi_ability_table -> psi_name_table (family) + strength.
Groups by PSI family so we can scope enemy-PSI support (offense/recovery/assist)."""
import os
import yaml

EB = "eb_project"
acts = yaml.safe_load(open(os.path.join(EB, "battle_action_table.yml"), encoding="utf-8"))
ens = yaml.safe_load(open(os.path.join(EB, "enemy_configuration_table.yml"), encoding="utf-8"))
psi = yaml.safe_load(open(os.path.join(EB, "psi_ability_table.yml"), encoding="utf-8"))
names = yaml.safe_load(open(os.path.join(EB, "psi_name_table.yml"), encoding="utf-8"))


def nm(i):
    e = names.get(i)
    return str(e.get("Name")).strip() if e else f"#{i}"


# action id -> (family name, strength, type)
act_psi = {}
for k, v in psi.items():
    if not isinstance(v, dict):
        continue
    a = v.get("Action")
    if a:
        act_psi[int(a)] = (nm(v.get("PSI Name")), v.get("Strength"), tuple(v.get("Type") or []))

# enemy -> list of (family,strength,type) it casts; also family -> set(enemies)
fam_enemies = {}
per_enemy = {}
for cid, c in ens.items():
    name = c.get("Name")
    if not name or str(name).strip().lower() == "null":
        continue
    sprite = int(c.get("Overworld Sprite", 0) or 0)
    for slot in ("Action 1", "Action 2", "Action 3", "Action 4", "Final Action"):
        a = int(c.get(slot, 0) or 0)
        if a in act_psi:
            fam, stg, typ = act_psi[a]
            per_enemy.setdefault(str(name).strip(), []).append((fam, stg, typ, sprite))
            fam_enemies.setdefault(fam, set()).add(str(name).strip())

print("=== PSI families cast by enemies (canon) ===")
for fam in sorted(fam_enemies, key=lambda f: -len(fam_enemies[f])):
    typ = ""
    for k, v in psi.items():
        if isinstance(v, dict) and nm(v.get("PSI Name")) == fam:
            typ = ",".join(v.get("Type") or [])
            break
    who = sorted(fam_enemies[fam])
    print(f"  {fam:<14} [{typ:<9}] {len(who):>2} enemies: {', '.join(who[:5])}{' …' if len(who) > 5 else ''}")

# how many enemies have an OVERWORLD sprite (spawnable in our world)
overworld = {e for e, lst in per_enemy.items() if any(s for *_, s in lst)}
print(f"\nEnemies casting any PSI: {len(per_enemy)}  |  with an overworld sprite (spawnable): {len(overworld)}")
