"""
Build correct mapping from ROM song numbers to Zophar SPC files.

EBMusEd's bgm_orig_title[] gives us ROM song names (indexed by song number).
Zophar's SPC ID666 tags give us track names.
We fuzzy-match them to create the correct eb-NNN.spc file set.
"""

import os
import re
import shutil
from pathlib import Path

# ROM song titles from EBMusEd metadata.c bgm_orig_title[]
# Index 0 = song 0x01 (1), index 1 = song 0x02 (2), etc.
ROM_SONGS = [
    "Gas Station",
    "Your Name, Please",
    "Choose a File",
    "None",
    "Fanfare - You Won!",
    "Level Up",
    "A Bad Dream",
    "Battle Swirl (Boss)",
    "Battle Swirl (Ambushed)",
    "(Unused)",
    "Fanfare - You've Got A New Friend!",
    "Fanfare - Instant Revitalization",
    "Teleportation - Departure",
    "Teleportation - Failure",
    "Falling Underground",
    "Doctor Andonuts' Lab",
    "Suspicious House",
    "Sloppy House",
    "Friendly Neighbors",
    "Arcade",
    "Pokey's House",
    "Hospital",
    "Home Sweet Home",
    "Paula's Theme",
    "Chaos Theater",
    "Enjoy Your Stay",
    "Good Morning, Eagleland",
    "Department Store",
    "Onett at Night (Version 1)",
    "Welcome to Your Sanctuary",
    "A Flash of Memory",
    "Melody - Giant Step",
    "Melody - Lilliput Steps",
    "Melody - Milky Well",
    "Melody - Rainy Circle",
    "Melody - Magnet Hill",
    "Melody - Pink Cloud",
    "Melody - Lumine Hall",
    "Melody - Fire Spring",
    "Third Strongest",
    "Alien Investigation (Stonehenge Base)",
    "Fire Spring",
    "Belch's Factory",
    "Threed, Zombie Central",
    "Spooky Cave",
    "Onett",
    "The Metropolis of Fourside",
    "Saturn Valley",
    "Monkey Caves",
    "Moonside Swing",
    "Dusty Dunes Desert",
    "Peaceful Rest Valley",
    "Happy Happy Village",
    "Winters White",
    "Caverns of Winters",
    "Summers, Eternal Tourist Trap",
    "Jackie's Cafe",
    "Sailing to Scaraba - Departure",
    "The Floating Kingdom of Dalaam",
    "Mu Training",
    "Bazaar",
    "Scaraba Desert",
    "In the Pyramid",
    "Deep Darkness",
    "Tenda Village",
    "Magicant - Welcome Home",
    "Magicant - Dark Thoughts",
    "Lost Underworld",
    "The Cliff That Time Forgot",
    "The Past",
    "Giygas' Lair",
    "Giygas Awakens",
    "Giygas - Struggling (Phase 2)",
    "Giygas - Weakening",
    "Giygas - Breaking Down",
    "Runaway Five, Live at the Chaos Theater",
    "Runaway Five, On Tour",
    "Runaway Five, Live at the Topolla Theater",
    "Magicant - The Power",
    "Venus' Performance",
    "Yellow Submarine",
    "Bicycle",
    "Sky Runner - In Flight",
    "Sky Runner - Going Down",
    "Bulldozer",
    "Tessie",
    "Greyhand Bus",
    "What a Great Photograph!",
    "Escargo Express at your Service!",
    "The Heroes Return (Part 1)",
    "Phase Distorter - Time Vortex",
    "Coffee Break",
    "Because I Love You",
    "Good Friends, Bad Friends",
    "Smiles and Tears",
    "Battle Against a Weird Opponent",
    "Battle Against a Machine",
    "Battle Against a Mobile Opponent",
    "Battle Against Belch",
    "Battle Against a New Age Retro Hippie",
    "Battle Against a Weak Opponent",
    "Battle Against an Unsettling Opponent",
    "Sanctuary Guardian",
    "Kraken of the Sea",
    "Giygas - Cease to Exist!",
    "Inside the Dungeon",
    "Megaton Walk",
    "Magicant - The Sea of Eden",
    "Sky Runner - Explosion (Unused)",
    "Sky Runner - Explosion",
    "Magic Cake",
    "Pokey's House (with Buzz Buzz)",
    "Buzz Buzz Swatted",
    "Onett at Night (Version 2, with Buzz Buzz)",
    "Phone Call",
    "Annoying Knock (Right)",
    "Pink Cloud Shrine",
    "Buzz Buzz Emerges",
    "Buzz Buzz's Prophecy",
    "Heartless Hotel",
    "Onett Flyover",
    "Onett (with sunrise)",
    "Fanfare - A Good Buddy",
    "Starman Junior Appears",
    "Snow Wood Boarding School",
    "Phase Distorter - Failure",
    "Phase Distorter - Teleport to Lost Underworld",
    "Boy Meets Girl (Twoson)",
    "Threed, Free At Last",
    "The Runaway Five, Free To Go!",
    "Flying Man",
    "Cave Ambiance",
    "Deep Underground (Unused)",
    "Greeting the Sanctuary Boss",
    "Teleportation - Arrival",
    "Saturn Valley Caverns",
    "Elevator (Going Down)",
    "Elevator (Going Up)",
    "Elevator (Stopping)",
    "Topolla Theater",
    "Battle Against Belch (Duplicate Entry)",
    "Magicant - Realization",
    "Magicant - Departure",
    "Sailing to Scaraba - Onwards!",
    "Stonehenge Base Shuts Down",
    "Tessie Watchers",
    "Meteor Fall",
    "Battle Against an Otherworldly Foe",
    "The Runaway Five To The Rescue!",
    "Annoying Knock (Left)",
    "Alien Investigation (Onett)",
    "Past Your Bedtime",
    "Pokey's Theme",
    "Onett at Night (Version 4, with Buzz Buzz)",
    "Greeting the Sanctuary Boss (Duplicate Entry)",
    "Meteor Strike",
    "Opening Credits",
    "Are You Sure? Yep!",
    "Peaceful Rest Valley Ambiance",
    "Sound Stone - Giant Step",
    "Sound Stone - Lilliput Steps",
    "Sound Stone - Milky Well",
    "Sound Stone - Rainy Circle",
    "Sound Stone - Magnet Hill",
    "Sound Stone - Pink Cloud",
    "Sound Stone - Lumine Hall",
    "Sound Stone - Fire Spring",
    "Sound Stone - Empty",
    "Eight Melodies",
    "Dalaam Flyover",
    "Winters Flyover",
    "Pokey's Theme (Helicopter)",
    "Good Morning, Moonside",
    "Gas Station (Part 2)",
    "Title Screen",
    "Battle Swirl (Normal)",
    "Pokey Springs Into Action",
    "Good Morning, Scaraba",
    "Robotomy",
    "Pokey's Helicopter (Unused)",
    "The Heroes Return (Part 2)",
    "Static",
    "Fanfare - Instant Victory",
    "You Win! (Version 3, versus Boss)",
    "Giygas - Lashing Out (Phase 3)",
    "Giygas - Mindless (Phase 1)",
    "Giygas - Give Us Strength!",
    "Good Morning, Winters",
    "Sound Stone - Empty (Duplicate Entry)",
    "Giygas - Breaking Down (Quiet)",
    "Giygas - Weakening (Quiet)",
]

# Manual mapping for tricky matches: ROM song name fragment -> Zophar track title fragment
# Built by comparing the two lists
MANUAL_MATCHES = {
    # ROM name keyword -> Zophar title keyword
    "Gas Station": None,  # No clear Zophar match (it's a jingle)
    "Your Name, Please": "Your Name, Please",
    "Choose a File": "Choose a File",
    "Fanfare - You Won!": "You Win!",
    "Level Up": "You Gained a Level!",
    "A Bad Dream": "A Bad Dream",
    "Fanfare - You've Got A New Friend!": "You've Got a New Friend!",
    "Falling Underground": "Falling Underground!",
    "Doctor Andonuts' Lab": "Dr. Andonuts' Lab",
    "Friendly Neighbors": "Friendly Neighbors",
    "Arcade": "Onett's Arcade",
    "Pokey's House": "Pokey's House",
    "Hospital": "Hospital",
    "Home Sweet Home": "Home Sweet Home",
    "Paula's Theme": "Paula's Theme",
    "Chaos Theater": "Dead-End Chaos Theatre",
    "Enjoy Your Stay": "Enjoy Your Stay",
    "Good Morning, Eagleland": "Sunrise & Onett Theme",  # This is the Onett overworld sunrise
    "Onett at Night (Version 1)": "Onett Night 1",
    "Welcome to Your Sanctuary": "Welcome to Your Sanctuary",
    "A Flash of Memory": "A Flash of Memory",
    "Melody - Giant Step": "Your Sanctuary ~ Giant Step",
    "Fire Spring": "Lava Springs",
    "Belch's Factory": "Belch's Factory",
    "Threed, Zombie Central": "Threed, Zombie Central",
    "Spooky Cave": "Dangerous Caves",
    "Onett": "Sunrise & Onett Theme",
    "The Metropolis of Fourside": "The Metropolis of Fourside",
    "Saturn Valley": "Hi Hi Hi",
    "Monkey Caves": "The Monkeys' Maze",
    "Moonside Swing": "Moonside Swing",
    "Dusty Dunes Desert": "Morning in the Desert",
    "Peaceful Rest Valley": "Peaceful Rest Valley",
    "Happy Happy Village": "Happy-Happy is Blue",
    "Winters White": "Winters White",
    "Caverns of Winters": "Caverns of Winters",
    "Summers, Eternal Tourist Trap": "Summers, Eternal Tourist Trap",
    "Sailing to Scaraba - Departure": "Sailing to Scaraba",
    "The Floating Kingdom of Dalaam": "The Floating Kingdom of Dalaam",
    "Mu Training": "Mu Training",
    "Bazaar": "Bazaar",
    "Scaraba Desert": "The Unforgiving Desert",
    "In the Pyramid": "Pyramid",
    "Deep Darkness": "The Deep Darkness",
    "Tenda Village": "The Tendas' Cave",
    "Magicant - Welcome Home": "Welcome Home",
    "Lost Underworld": "The Lost Underworld",
    "The Cliff That Time Forgot": "The Cliff That Time Forgot",
    "The Past": "The Place",
    "Giygas' Lair": "Giygas' Lair",
    "Giygas Awakens": "Giygas' Intro",
    "Giygas - Struggling (Phase 2)": "Giygas Stirs",
    "Giygas - Weakening": "Giygas is Wounded!",
    "Giygas - Breaking Down": "Giygas is Fatally Wounded!",
    "Runaway Five, Live at the Chaos Theater": "Runaway Five ~ The Daily Show",
    "Runaway Five, On Tour": "Runaway Five on the Move!",
    "Runaway Five, Live at the Topolla Theater": "Runaway Five's Final Performance",
    "Magicant - The Power": "The Power",
    "Venus' Performance": "Venus Live!",
    "Bicycle": "Ness' Bike",
    "Sky Runner - In Flight": "The Sky Runner",
    "Sky Runner - Going Down": "Going Down!",
    "Tessie": "Tessie!",
    "What a Great Photograph!": "What a Great Picture!",
    "Escargo Express at your Service!": "Escargo Express at Your Service!",
    "The Heroes Return (Part 1)": "The Heroes Return (part 1)",
    "Coffee Break": "You've Come Far, Ness",
    "Because I Love You": "Because I Love You",
    "Good Friends, Bad Friends": "Good Friends, Bad Friends",
    "Smiles and Tears": "Smiles and Tears",
    "Battle Against a Weird Opponent": "Battle Against a Weird Opponent",
    "Battle Against a Machine": "Battle Against a Machine",
    "Battle Against a Mobile Opponent": "Battle Against a Mobile Opponent",
    "Battle Against Belch": "Battle Against Belch",
    "Battle Against a Weak Opponent": "Battle Against a Weak Opponent",
    "Battle Against an Unsettling Opponent": "Battle Against an Unsettling Opp",
    "Sanctuary Guardian": "Sanctuary Guardian",
    "Kraken of the Sea": "Kraken of the Sea",
    "Giygas - Cease to Exist!": "Pokey Means Business!",
    "Inside the Dungeon": "Inside the Dungeon",
    "Megaton Walk": "Megaton Walk",
    "Magicant - The Sea of Eden": "Sea of Eden",
    "Pokey's House (with Buzz Buzz)": "Onett Buzz Buzz 1",
    "Onett at Night (Version 2, with Buzz Buzz)": "Onett Night 1",
    "Pink Cloud Shrine": "Pink Cloud Shrine",
    "Buzz Buzz's Prophecy": "Buzz Buzz's Prophecy",
    "Heartless Hotel": "Heartless Hotel",
    "Onett (with sunrise)": "Sunrise & Onett Theme",
    "Fanfare - A Good Buddy": "A Good Buddy",
    "Snow Wood Boarding School": "Snowman",
    "Boy Meets Girl (Twoson)": "Boy Meets Girl",
    "Threed, Free At Last": "Threed, Free at Last",
    "Saturn Valley Caverns": "Saturn Valley Caverns",
    "Topolla Theater": "Topolla Theatre, Home to the One",
    "Stonehenge Base Shuts Down": "Stonehenge Base Shuts Down",
    "Battle Against an Otherworldly Foe": "Otherworldly Foe",
    "The Runaway Five To The Rescue!": "Runaway Five to the Rescue!",
    "Pokey's Theme": "Pokey",
    "Opening Credits": "Opening Credits",
    "Eight Melodies": "Eight Melodies",
    "Title Screen": "Title Screen",
    "Giygas - Lashing Out (Phase 3)": "Giygas' Intimidation",
    "Giygas - Mindless (Phase 1)": "The Evil Giygas Attacks! (part 1",
    "Giygas - Give Us Strength!": "Prayer for Safety",
    "Giygas - Breaking Down (Quiet)": "Giygas Disintegrates",
    "Giygas - Weakening (Quiet)": "Giygas is Fatally Wounded!",
    # Sound effects / jingles / ambiance - many won't have SPC matches
    "Onett Flyover": "Sunrise & Onett Theme",
    "Meteor Fall": "Unidentified Falling Object",
    "Save the Miners!": "Save the Miners!",
    "Alien Investigation (Onett)": "Alien Invasion 1",
    "Annoying Knock (Right)": "Someone's Knocking at the Door",
    "Fanfare - Instant Revitalization": None,
    "Teleportation - Departure": None,
    "Teleportation - Failure": None,
    "Battle Swirl (Boss)": None,
    "Battle Swirl (Ambushed)": None,
    "Battle Swirl (Normal)": None,
    "Phone Call": None,
    "Buzz Buzz Emerges": None,
    "Starman Junior Appears": None,
    "Elevator (Going Down)": None,
    "Elevator (Going Up)": None,
    "Elevator (Stopping)": None,
    "Teleportation - Arrival": None,
    "(Unused)": None,
    "None": None,
    "Static": "Giygas' Static",
    "Magicant - Realization": "Ness Awakens from the Nightmare",
    "Magicant - Departure": "Spacetoneer",
    "Sailing to Scaraba - Onwards!": "Sailing to Scaraba",
    "The Submarine": "The Submarine",
    "Bulldozer": None,
    "Yellow Submarine": "The Submarine",
    "Greyhand Bus": "Get on the Bus",
    "Tessie Watchers": "Tessie Has Been Sighted!",
    "Alien Investigation (Stonehenge Base)": "Alien Invasion 1",
    "Suspicious House": "Pokey's House",  # Similar theme
    "Sloppy House": None,
    "Department Store": None,
    "Jackie's Cafe": "Boris' Cocktail",
    "Third Strongest": None,  # MOTHER 1 track
    "Magicant - Dark Thoughts": "Deeper into Ness' Subconscious",
    "The Cliff That Time Forgot": "The Cliff That Time Forgot",
    "Sky Runner - Explosion (Unused)": "Rough Landing",
    "Sky Runner - Explosion": "Rough Landing",
    "Magic Cake": "In Dalaam, There is a Warrior",
    "Buzz Buzz Swatted": "Whoa!",
    "Cave Ambiance": None,
    "Deep Underground (Unused)": None,
    "Greeting the Sanctuary Boss": "Sanctuary Guardian's Challenge",
    "Past Your Bedtime": "One Fateful Night...",
    "Phase Distorter - Failure": "Phase Distorter Failed",
    "Phase Distorter - Teleport to Lost Underworld": "Phase Distorter Failed",
    "The Runaway Five, Free To Go!": "Runaway Five Left the Building!",
    "Flying Man": "The Jolly Flying Man",
    "Meteor Strike": "Unidentified Falling Object",
    "Are You Sure? Yep!": "Now, Let's Go!",
    "Peaceful Rest Valley Ambiance": None,
    "Dalaam Flyover": "In Dalaam, There is a Warrior",
    "Winters Flyover": "In Winters, There is a Genius",
    "Pokey's Theme (Helicopter)": "Pokey",
    "Good Morning, Moonside": "Bad Morning to You",
    "Gas Station (Part 2)": None,
    "Pokey Springs Into Action": "Pokey",
    "Good Morning, Scaraba": "Morning in the Desert",
    "Robotomy": None,
    "Pokey's Helicopter (Unused)": None,
    "The Heroes Return (Part 2)": "The Heroes Return (part 1)",
    "Fanfare - Instant Victory": "That Was Easy!",
    "You Win! (Version 3, versus Boss)": "You Win!",
    "Good Morning, Winters": "Winters Wake Up Call",
    "Sound Stone - Empty": None,
    "Sound Stone - Empty (Duplicate Entry)": None,
    "Sound Stone - Giant Step": "Sound Stone ~ Giant Step",
    "Sound Stone - Lilliput Steps": "Sound Stone ~ Giant Step",  # Same melody base
    "Sound Stone - Milky Well": "Sound Stone ~ Giant Step",
    "Sound Stone - Rainy Circle": "Sound Stone ~ Giant Step",
    "Sound Stone - Magnet Hill": "Sound Stone ~ Giant Step",
    "Sound Stone - Pink Cloud": "Sound Stone ~ Giant Step",
    "Sound Stone - Lumine Hall": "Sound Stone ~ Giant Step",
    "Sound Stone - Fire Spring": "Sound Stone ~ Giant Step",
    "Onett at Night (Version 4, with Buzz Buzz)": "Onett Night 1",
    "Greeting the Sanctuary Boss (Duplicate Entry)": "Sanctuary Guardian's Challenge",
    "Battle Against Belch (Duplicate Entry)": "Battle Against Belch",
    "Battle Against a New Age Retro Hippie": "Battle Against a Weak Opponent",  # Similar
    "Tenda Village": "The Tendas' Cave",
}

SPC_SOURCE = Path(os.environ.get("TEMP", "/tmp")) / "eb_spc_extracted"
OUT_DIR = Path(__file__).parent.parent / "public" / "assets" / "music" / "spc"


def read_spc_title(path):
    with open(path, "rb") as f:
        data = f.read(256)
    return data[0x2E:0x4E].split(b"\x00")[0].decode("ascii", errors="replace").strip()


def normalize(s):
    """Normalize for fuzzy matching."""
    s = s.lower()
    s = re.sub(r'[^a-z0-9 ]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def main():
    # Build Zophar title -> track number mapping
    zophar_tracks = {}  # normalized title -> (track_num, spc_path)
    zophar_by_num = {}  # track_num -> (title, spc_path)

    # Check both the extracted dir and the current output dir
    spc_dir = OUT_DIR  # Use existing files
    if not spc_dir.exists():
        print(f"SPC directory not found: {spc_dir}")
        return

    for spc_file in sorted(spc_dir.glob("eb-*.spc")):
        num = int(spc_file.stem.split("-")[1])
        title = read_spc_title(spc_file)
        zophar_tracks[normalize(title)] = (num, spc_file, title)
        zophar_by_num[num] = (title, spc_file)

    print(f"Found {len(zophar_tracks)} Zophar SPC tracks")
    print(f"ROM has {len(ROM_SONGS)} songs")

    # Build ROM song number -> Zophar track number mapping
    mapping = {}  # rom_song_num -> zophar_track_num
    unmatched = []

    for i, rom_name in enumerate(ROM_SONGS):
        rom_num = i + 1  # 1-indexed

        # Check manual mapping first
        if rom_name in MANUAL_MATCHES:
            zophar_title = MANUAL_MATCHES[rom_name]
            if zophar_title is None:
                continue  # No SPC available for this
            norm = normalize(zophar_title)
            if norm in zophar_tracks:
                z_num, z_path, z_title = zophar_tracks[norm]
                mapping[rom_num] = z_num
                continue

        # Try fuzzy match
        norm_rom = normalize(rom_name)
        best_score = 0
        best_match = None
        for norm_z, (z_num, z_path, z_title) in zophar_tracks.items():
            # Simple word overlap score
            rom_words = set(norm_rom.split())
            z_words = set(norm_z.split())
            if not rom_words or not z_words:
                continue
            overlap = len(rom_words & z_words)
            score = overlap / max(len(rom_words), len(z_words))
            if score > best_score:
                best_score = score
                best_match = (z_num, z_title)

        if best_score >= 0.5 and best_match:
            mapping[rom_num] = best_match[0]
        else:
            unmatched.append((rom_num, rom_name))

    print(f"\nMatched {len(mapping)} ROM songs to Zophar tracks")
    print(f"Unmatched: {len(unmatched)}")

    # Now create correctly-numbered SPC files
    # We need to copy Zophar track N to eb-{rom_song_num}.spc
    temp_dir = OUT_DIR / "_temp"
    temp_dir.mkdir(exist_ok=True)

    # First copy all source files to temp
    for spc_file in OUT_DIR.glob("eb-*.spc"):
        shutil.copy2(spc_file, temp_dir / spc_file.name)

    # Now create correctly-mapped files
    created = 0
    for rom_num, zophar_num in sorted(mapping.items()):
        src = temp_dir / f"eb-{zophar_num:03d}.spc"
        dst = OUT_DIR / f"eb-{rom_num:03d}.spc"
        if src.exists():
            shutil.copy2(src, dst)
            z_title = zophar_by_num.get(zophar_num, ("?",))[0]
            rom_name = ROM_SONGS[rom_num - 1]
            if rom_num != zophar_num:
                print(f"  ROM {rom_num:3d} ({rom_name[:35]:35s}) <- Zophar {zophar_num:3d} ({z_title})")
            created += 1

    # Cleanup temp
    for f in temp_dir.glob("*"):
        f.unlink()
    temp_dir.rmdir()

    print(f"\nCreated {created} correctly-mapped SPC files")

    if unmatched:
        print(f"\nUnmatched ROM songs (no SPC available):")
        for num, name in unmatched:
            print(f"  {num:3d}: {name}")

    # Check which songs in music_map.json we still need
    import json
    music_map_path = OUT_DIR.parent / "music_map.json"
    if music_map_path.exists():
        with open(music_map_path) as f:
            music_map = json.load(f)
        needed = sorted(set(v for v in music_map.values() if v > 0))
        have = sorted(int(f.stem.split("-")[1]) for f in OUT_DIR.glob("eb-*.spc"))
        missing = [n for n in needed if n not in have]
        if missing:
            print(f"\nStill missing songs needed for map music: {missing}")
            for n in missing:
                name = ROM_SONGS[n-1] if n <= len(ROM_SONGS) else "?"
                print(f"  {n:3d}: {name}")
        else:
            print(f"\nAll {len(needed)} map music songs are present!")


if __name__ == "__main__":
    main()
