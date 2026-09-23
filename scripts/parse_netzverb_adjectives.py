"""Parse the raw Netzverb B1-adjectives page dump into structured JSON.

The source file is a straight copy-paste of Netzverb's declension pages, so each
adjective appears as either one block (positive form only, for non-comparable
adjectives) or three repeated blocks (positive/comparative/superlative, each
carrying the same Korean gloss). We only want the dictionary (positive) form and
its meaning, so comparative/superlative blocks are dropped entirely.

Each positive block looks like:

    B1 · adjective · positive · regular · comparable
                                              <- blank line
    abgeschlossen <pos.>                     <- word line (tag omitted if not comparable)
    abgeschlossen · abgeschlossener · am abgeschlossensten   <- pos/comp/sup forms
                                              <- blank line
    Korean 끝난, 독립적인, 완료된, ...          <- meaning line
                                              <- blank line
    /IPA/ · /IPA/ · ...                      <- pronunciation (ignored)
                                              <- blank line
    German definition ...                    <- ignored

Usage: python scripts/parse_netzverb_adjectives.py
Output: static/b1_adjectives_netzverb.json
"""

import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "All German B1 adjectives on Netzverb.txt"
OUT = ROOT / "static" / "b1_adjectives_netzverb.json"  # served directly by Flask's static route

WORD_TAG_RE = re.compile(r"\s*<(pos|comp|sup)\.>\s*$")


def main():
    with open(SRC, encoding="utf-8") as f:
        text = f.read()

    blocks = re.split(r"\n(?=B1 · adjective · )", text)
    pos_blocks = [b for b in blocks if b.startswith("B1 · adjective · positive")]

    entries = []
    skipped = []
    for block in pos_blocks:
        lines = block.split("\n")
        word_line = lines[2].strip() if len(lines) > 2 else ""
        headword = WORD_TAG_RE.sub("", word_line).strip()

        meaning_line = next((l for l in lines if l.startswith("Korean ")), None)
        meaning_ko = meaning_line[len("Korean "):].strip() if meaning_line else None

        if not headword or not meaning_ko:
            skipped.append(block[:80])
            continue

        entries.append({"headword": headword, "meaning_ko": meaning_ko})

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)

    dupes = {h for h in (e["headword"] for e in entries) if [e["headword"] for e in entries].count(h) > 1}

    print(f"Positive-form blocks found: {len(pos_blocks)}")
    print(f"Entries written: {len(entries)}")
    print(f"Skipped (missing headword/meaning): {len(skipped)}")
    print(f"Duplicate headwords: {sorted(dupes) if dupes else 'none'}")
    print(f"Output: {OUT}")


if __name__ == "__main__":
    main()
