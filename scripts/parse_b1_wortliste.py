"""Parse the alphabetical word list (pages 16-102) of the official Goethe-Zertifikat
B1 Wortliste PDF into structured JSON.

The PDF lays each page out as two side-by-side sub-layouts (left half, right half),
each containing a headword sub-column and an example-sentence sub-column. Plain
text extraction reads all headwords in a half before all examples in that half, so
this script works from block-level bounding boxes (pymupdf) instead, matching each
headword to its example(s) by vertical position.

Usage: python scripts/parse_b1_wortliste.py
Output: static/goethe_b1_wortliste.json
"""

import json
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from wordforms import bare_candidate_words

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SRC = ROOT / "data" / "Goethe-Zertifikat_B1_Wortliste.pdf"
OUT = ROOT / "static" / "goethe_b1_wortliste.json"  # served directly by Flask's static route
FIRST_PAGE = 16  # 1-indexed, inclusive
LAST_PAGE = 102  # 1-indexed, inclusive

HALF_SPLIT_X = 297.0
LEFT_HW_MAX_X = 128.0
RIGHT_HW_MAX_X = 405.0
LEFT_BASE_X = 35.2
RIGHT_BASE_X = 314.6
INDENT_TOLERANCE = 8.0

VERB_LAST_SEGMENT_RE = re.compile(r"^(es\s+)?(hat|ist)(/(hat|ist))?\b")
LETTER_HEADER_RE = re.compile(r"^[A-ZÄÖÜ]$")
COMPOUND_TAIL_RE = re.compile(r"^[a-zäöüß]+,\s*(-|¨)")


def join_block_lines(raw_text):
    """Join a PDF text block's lines into one string, de-hyphenating soft line-wraps."""
    lines = [l.strip() for l in raw_text.split("\n") if l.strip() != ""]
    if not lines:
        return ""
    out = lines[0]
    for line in lines[1:]:
        if out.endswith("-") and len(out) > 1:
            out = out[:-1] + line
        else:
            out = out + " " + line
    return re.sub(r"\s+", " ", out).strip()


def split_examples(text):
    """Split a joined example-block string into one string per numbered sense.

    Only treats leading "N." markers as sense numbers when they're preceded by
    sentence-ending punctuation (so dates like "25. April" inside a sentence
    aren't mistaken for a new sense).
    """
    text = text.strip()
    if not text:
        return []
    m1 = re.match(r"^1\.\s*", text)
    if not m1:
        return [text]

    positions = [(0, m1.end())]
    search_from = m1.end()
    n = 2
    while True:
        found = None
        for mm in re.finditer(re.escape(str(n)) + r"\.\s*", text):
            if mm.start() < search_from:
                continue
            j = mm.start() - 1
            while j >= 0 and text[j] == " ":
                j -= 1
            if j >= 0 and text[j] in ".!?":
                found = mm
                break
        if not found:
            break
        positions.append((found.start(), found.end()))
        search_from = found.end()
        n += 1

    chunks = []
    for idx, (_, mend) in enumerate(positions):
        chunk_end = positions[idx + 1][0] if idx + 1 < len(positions) else len(text)
        chunks.append(text[mend:chunk_end].strip())
    return chunks


def is_fragment(text, x0, base_x):
    """Detect stray continuation fragments (e.g. a wrapped plural suffix like
    '-e' that pymupdf split into its own block) that should be merged into the
    previous headword block rather than treated as a new entry."""
    if x0 <= base_x + INDENT_TOLERANCE:
        return False
    if text.startswith("-") or text.startswith("¨"):
        return True
    if len(text) <= 3:
        return True
    return False


def classify_blocks(blocks):
    """Split a page's text blocks into left/right halves, each split into a
    headword band and an example band."""
    bands = {
        "left_hw": [],
        "left_ex": [],
        "right_hw": [],
        "right_ex": [],
    }
    for x0, y0, x1, y1, text, bno, btype in blocks:
        if btype != 0:
            continue
        if y0 < 40 or y0 > 800:
            continue
        if x0 < 25 and (x1 - x0) < 15:
            continue  # rotated "VS_03" margin strip
        joined = join_block_lines(text)
        if not joined:
            continue
        if joined == "2 Alphabetischer Wortschatz":
            continue  # section title on page 16, not a dictionary entry
        if x0 < HALF_SPLIT_X:
            if x0 < LEFT_HW_MAX_X:
                bands["left_hw"].append((y0, x0, joined))
            else:
                bands["left_ex"].append((y0, x0, joined))
        else:
            if x0 < RIGHT_HW_MAX_X:
                bands["right_hw"].append((y0, x0, joined))
            else:
                bands["right_ex"].append((y0, x0, joined))
    for key in bands:
        bands[key].sort(key=lambda t: t[0])
    return bands


def is_verb_tail_fragment(text, level):
    """Detect an indented block that's actually the tail end of a verb's
    principal-parts list (infinitive + some forms left behind in the previous
    block, e.g. 'beeinflusste, hat beeinflusst' split off from 'beeinflussen,
    beeinflusst,'), rather than a genuine standalone Nebeneintrag."""
    if level != 1:
        return False
    segs = [s.strip() for s in text.split(",")]
    return 1 <= len(segs) < 4 and bool(VERB_LAST_SEGMENT_RE.match(segs[-1]))


def clean_headwords(hw_blocks, base_x, warnings, page_num):
    """Drop single-letter section headers, merge stray continuation fragments
    into the preceding entry, and tag each remaining headword with its
    indentation level."""
    cleaned = []
    for y0, x0, text in hw_blocks:
        if LETTER_HEADER_RE.match(text):
            continue
        level = 1 if x0 > base_x + INDENT_TOLERANCE else 0
        if cleaned and is_fragment(text, x0, base_x):
            prev_y0, prev_text, prev_level = cleaned[-1]
            sep = " " if text.startswith(("-", "¨")) and not prev_text.endswith("-") else ""
            merged = prev_text + sep + text
            cleaned[-1] = (prev_y0, merged, prev_level)
            warnings.append(f"page {page_num}: merged suffix fragment {text!r} into {prev_text!r}")
            continue
        if cleaned and is_verb_tail_fragment(text, level):
            prev_y0, prev_text, prev_level = cleaned[-1]
            merged = prev_text + " " + text
            cleaned[-1] = (prev_y0, merged, prev_level)
            warnings.append(f"page {page_num}: merged verb-tail fragment {text!r} into {prev_text!r}")
            continue
        if cleaned and level == 1 and COMPOUND_TAIL_RE.match(text):
            # e.g. 'beschränkung, -en' split off from a preceding 'Geschwindigkeits-'
            prev_y0, prev_text, prev_level = cleaned[-1]
            merged = prev_text[:-1] + text if prev_text.endswith("-") else prev_text + text
            cleaned[-1] = (prev_y0, merged, prev_level)
            warnings.append(f"page {page_num}: merged compound-tail fragment {text!r} into {prev_text!r}")
            continue
        if cleaned and level == 1 and (
            cleaned[-1][1].endswith("/") or re.search(r"/(der|die|das)$", cleaned[-1][1])
        ):
            # e.g. 'die Ehefrau, -en/der' + 'Ehemann, ¨-er' (paired-gender headword wrap)
            prev_y0, prev_text, prev_level = cleaned[-1]
            sep = "" if prev_text.endswith("/") else " "
            merged = prev_text + sep + text
            cleaned[-1] = (prev_y0, merged, prev_level)
            warnings.append(f"page {page_num}: merged paired-headword fragment {text!r} into {prev_text!r}")
            continue
        cleaned.append((y0, text, level))
    return cleaned


def pair_examples(headwords, ex_blocks):
    """For each headword (y0, text, level), collect example blocks whose y0
    falls within its vertical span (up to the next headword's y0)."""
    results = []
    for i, (y0, text, level) in enumerate(headwords):
        y_start = y0 - 5
        y_end = headwords[i + 1][0] - 5 if i + 1 < len(headwords) else float("inf")
        matched = [t for (ey0, ex0, t) in ex_blocks if y_start <= ey0 < y_end]
        example_text = " ".join(matched)
        results.append((text, level, split_examples(example_text)))
    return results


# A handful of entries have no example between them and no blank vertical gap,
# so pymupdf merges two distinct dictionary entries into a single text block
# (confirmed by rendering the source pages). These exact three cases were
# identified and verified by hand; split them back into two entries each,
# using their already-matched example text (manually apportioned per entry).
KNOWN_SPLITS = {
    "besichtigen, besichtigt, besichtigte, hat besichtigt besitzen, besitzt, besaß, hat besessen": [
        ("besichtigen, besichtigt, besichtigte, hat besichtigt",
         ["Im Urlaub haben wir Schloss Schönbrunn besichtigt."]),
        ("besitzen, besitzt, besaß, hat besessen",
         ["Besitzt Ihre Frau ein eigenes Auto?"]),
    ],
    "der Schirm, -e schlafen, schläft, schlief, hat geschlafen": [
        ("der Schirm, -e", ["Es regnet. Hast du einen Schirm dabei?"]),
        ("schlafen, schläft, schlief, hat geschlafen",
         ["Haben Sie gut geschlafen?",
          "Wenn Sie mal nach München kommen, können Sie bei uns schlafen."]),
    ],
    "die Träne, -n transportieren, transportiert, transportierte, hat transportiert": [
        ("die Träne, -n", ["Sie trocknet dem Kind die Tränen."]),
        ("transportieren, transportiert, transportierte, hat transportiert",
         ["Wie willst du die Möbel denn transportieren?"]),
    ],
}


def apply_known_splits(paired, warnings, page_num):
    expanded = []
    for text, level, examples in paired:
        if text in KNOWN_SPLITS:
            for split_text, split_examples_ in KNOWN_SPLITS[text]:
                expanded.append((split_text, level, split_examples_))
            warnings.append(f"page {page_num}: split known merged entry {text!r}")
        else:
            expanded.append((text, level, examples))
    return expanded


def build_entry(headword_text, level, examples, page_num):
    segments = [s.strip() for s in headword_text.split(",")]
    entry = {
        "headword": headword_text,
        "level": level,
        "parent": None,
        "examples": examples,
        "page": page_num,
    }
    if len(segments) >= 2 and VERB_LAST_SEGMENT_RE.match(segments[-1]):
        if len(segments) == 4:
            entry["headword"] = segments[0]
            entry["present_3sg"] = segments[1]
            entry["preterite"] = segments[2]
            entry["perfect"] = segments[3]
        # else: leave as an unsplit raw headword (logged separately by caller)
    return entry


# A handful of entries could not be reliably auto-repaired (genuine PDF typos,
# region-tag parentheticals that wrap across more than two blocks, a dual
# transitive/intransitive verb entry, etc.). These were identified by hand
# against the rendered PDF pages and are patched here: each tuple removes the
# listed (page, current headword) entries and inserts the given replacement
# entry/entries at that position, preserving document order.
MANUAL_FIXES = [
    (
        [(37, "erschrecken, erschrickt, erschrak, ist erschrocken/ jdn. erschrecken, erschreckt, erschreckte, hat erschreckt")],
        [
            {"headword": "erschrecken", "present_3sg": "erschrickt", "preterite": "erschrak",
             "perfect": "ist erschrocken", "level": 0, "parent": None,
             "examples": ["Du hast richtig krank ausgesehen. Ich war ganz erschrocken."], "page": 37},
            {"headword": "jdn. erschrecken", "present_3sg": "erschreckt", "preterite": "erschreckte",
             "perfect": "hat erschreckt", "level": 0, "parent": None,
             "examples": ["Hast du mich aber erschreckt!", "Entschuldigung. Ich wollte Sie nicht erschrecken."],
             "page": 37},
        ],
    ),
    (
        [(40, "festnehmen nimmt fest, nahm fest, hat festgenommen.")],
        [
            {"headword": "festnehmen", "present_3sg": "nimmt fest", "preterite": "nahm fest",
             "perfect": "hat festgenommen", "level": 0, "parent": None,
             "examples": ["Die Polizei hat einen Mann festgenommen."], "page": 40},
        ],
    ),
    (
        [(46, "gießen, gießt, goss, gegossen")],
        [
            {"headword": "gießen", "present_3sg": "gießt", "preterite": "goss",
             "perfect": "hat gegossen", "level": 0, "parent": None,
             "examples": ["Es hat nicht geregnet. Ich muss meine Blumen gießen."], "page": 46},
        ],
    ),
    (
        [(49, "heraus-, raus(heraus-) finden, findet"), (49, "heraus, fand heraus, hat herausgefunden")],
        [
            {"headword": "heraus-, raus-", "level": 0, "parent": None, "examples": [], "page": 49},
            {"headword": "(heraus-)finden", "present_3sg": "findet heraus", "preterite": "fand heraus",
             "perfect": "hat herausgefunden", "level": 1, "parent": "heraus-, raus-",
             "examples": ["Hast du schon rausgefunden, wann und wo man sich für den Kurs anmelden muss?"],
             "page": 49},
        ],
    ),
    (
        [(70, "in Pension gehen/sein (D,"), (70, "A) →D: in Rente gehen/sein; D, CH: pen-"),
         (70, "sioniert werden/sein")],
        [
            {"headword": "in Pension gehen/sein (D, A) →D: in Rente gehen/sein; D, CH: pensioniert werden/sein",
             "level": 0, "parent": None,
             "examples": ["Ich gehe Ende des Jahres in Pension.", "Mein Nachbar ist seit zehn Jahren in Pension."],
             "page": 70},
        ],
    ),
    (
        [(70, "pensioniert werden/sein (D, CH) →D, A: in Pension"), (70, "gehen/sein; D: in Rente"),
         (70, "gehen/sein")],
        [
            {"headword": "pensioniert werden/sein (D, CH) →D, A: in Pension gehen/sein; D: in Rente gehen/sein",
             "level": 0, "parent": None,
             "examples": ["Ich werde Ende des Jahres pensioniert.", "Mein Nachbar ist seit zehn Jahren pensioniert."],
             "page": 70},
        ],
    ),
    (
        [(70, "der Pensionist, -en / die Pensionistin, -nen (A) →D,"), (70, "CH: Rentner")],
        [
            {"headword": "der Pensionist, -en / die Pensionistin, -nen (A) →D, CH: Rentner",
             "level": 0, "parent": None,
             "examples": ["Meine Großmutter arbeitet nicht mehr. Sie ist Pensionistin."], "page": 70},
        ],
    ),
    (
        [(74, "in Rente gehen/sein (D) →"), (74, "D, A: in Pension gehen/sein; CH, D: pen-"),
         (74, "sioniert werden/sein"), (74, "der Rentner, die Rentnerin, -nen (D, CH) →A: Pensionist")],
        [
            {"headword": "in Rente gehen/sein (D) →D, A: in Pension gehen/sein; CH, D: pensioniert werden/sein",
             "level": 0, "parent": None,
             "examples": ["Ich gehe Ende des Jahres in Rente.", "Mein Nachbar ist seit zehn Jahren in Rente."],
             "page": 74},
            {"headword": "der Rentner, die Rentnerin, -nen (D, CH) →A: Pensionist",
             "level": 0, "parent": None,
             "examples": ["Meine Großmutter arbeitet nicht mehr. Sie ist Rentnerin."], "page": 74},
        ],
    ),
    (
        [(72, "Ratschlag, ¨-e")],
        [
            {"headword": "der Ratschlag, ¨-e", "level": 1, "parent": "raten",
             "examples": ["Meine Tochter nimmt meine Ratschläge nicht an."], "page": 72},
        ],
    ),
    (
        [(84, "die Straßenbahn, -en (D,"), (84, "A) →CH: Tram")],
        [
            {"headword": "die Straßenbahn, -en (D, A) →CH: Tram", "level": 1, "parent": "die Straße, -n",
             "examples": ["Fahren wir mit der Straßenbahn oder der U-Bahn?"], "page": 84},
        ],
    ),
    (
        [(87, "das Tram, -s →D,"), (87, "A: Straßenbahn")],
        [
            {"headword": "das Tram, -s →D, A: Straßenbahn", "level": 0, "parent": None,
             "examples": ["Fahren wir mit dem Tram oder dem Bus?"], "page": 87},
        ],
    ),
    (
        [(88, "das Treppenhaus, ¨-er (D,"), (88, "CH) →A: Stiegenhaus")],
        [
            {"headword": "das Treppenhaus, ¨-er (D, CH) →A: Stiegenhaus", "level": 0, "parent": None,
             "examples": ["Im Treppenhaus ist kein Licht."], "page": 88},
        ],
    ),
    # Same trailing-arrow fragmentation pattern (a cross-reference block ending in "→"
    # gets split from its continuation), found later via a broader scan than the
    # trailing-comma check above covered.
    (
        [(17, "das Altenheim, -e →"), (17, "Altersheim")],
        [
            {"headword": "das Altenheim, -e → Altersheim", "level": 1, "parent": "das Alter",
             "examples": ["Die Großeltern unserer Nachbarn sind im Altenheim."], "page": 17},
        ],
    ),
    (
        [(17, "das Altersheim, -e →"), (17, "Altenheim")],
        [
            {"headword": "das Altersheim, -e → Altenheim", "level": 1, "parent": "das Alter",
             "examples": ["Die Großeltern unserer Nachbarn sind im Altersheim."], "page": 17},
        ],
    ),
    (
        [(28, "der Briefumschlag, ¨-e →"), (28, "A: Kuvert; CH: Couvert")],
        [
            {"headword": "der Briefumschlag, ¨-e → A: Kuvert; CH: Couvert", "level": 0, "parent": None,
             "examples": ["Ich hätte gern 50 Briefumschläge und Briefmarken dazu."], "page": 28},
        ],
    ),
    (
        [(36, "der Erdapfel, ¨- (A) →"), (36, "Kartoffel")],
        [
            {"headword": "der Erdapfel, ¨- (A) → Kartoffel", "level": 1, "parent": None,
             "examples": ["Kann ich bitte noch Erdäpfel bekommen?"], "page": 36},
        ],
    ),
    (
        [(39, "der Familienstand (D, A) →"), (39, "Personenstand;"), (39, "CH: Zivilstand")],
        [
            {"headword": "der Familienstand (D, A) → Personenstand; CH: Zivilstand", "level": 0, "parent": None,
             "examples": ["Bei „Familienstand“ musst du „ledig“ ankreuzen."], "page": 39},
        ],
    ),
    (
        [(68, "der Ober, - (D, A) →"), (68, "Kellner; CH: Serviceangestellter")],
        [
            {"headword": "der Ober, - (D, A) → Kellner; CH: Serviceangestellter", "level": 1, "parent": "oben",
             "examples": ["Ich bin Ober von Beruf."], "page": 68},
        ],
    ),
    (
        [(71, "der Pöstler, - / die Pöstlerin, -nen (CH) →"), (71, "Briefträger")],
        [
            {"headword": "der Pöstler, - / die Pöstlerin, -nen (CH) → Briefträger", "level": 1, "parent": "die Post",
             "examples": ["War die Pöstlerin schon da?"], "page": 71},
        ],
    ),
    (
        [(70, "der Personenstand →D, A:"), (70, "Familienstand;"), (70, "CH: Zivilstand")],
        [
            {"headword": "der Personenstand →D, A: Familienstand; CH: Zivilstand", "level": 0, "parent": None,
             "examples": ["Bei „Personenstand“ musst du „ledig“ ankreuzen."], "page": 70},
        ],
    ),
    (
        # Source PDF itself has the space characters missing around this small
        # cross-reference note ("→CH:dieBriefträgerin,-nen"); reconstructed using
        # the paired-gender-noun format used throughout the doc, plus the CH synonym
        # confirmed by the reverse reference on p.71 ("der Pöstler ... → Briefträger").
        [(28, "der Briefträger, →CH:dieBriefträgerin,-nen"), (28, "Pöstler")],
        [
            {"headword": "der Briefträger, - / die Briefträgerin, -nen → CH: Pöstler", "level": 0, "parent": None,
             "examples": ["War die Briefträgerin schon da?"], "page": 28},
        ],
    ),
]


def apply_manual_fixes(entries):
    for removals, replacements in MANUAL_FIXES:
        indices = []
        for page, headword in removals:
            idx = next(
                (i for i, e in enumerate(entries) if e["page"] == page and e["headword"] == headword),
                None,
            )
            if idx is None:
                raise ValueError(f"manual fix target not found: page {page} {headword!r}")
            indices.append(idx)
        insert_at = min(indices)
        for idx in sorted(indices, reverse=True):
            entries.pop(idx)
        for offset, new_entry in enumerate(replacements):
            entries.insert(insert_at + offset, new_entry)
    return entries


def main():
    doc = pymupdf.open(SRC)
    entries = []
    warnings = []
    unsplit_verbs = []

    for page_idx in range(FIRST_PAGE - 1, LAST_PAGE):
        page_num = page_idx + 1
        blocks = doc[page_idx].get_text("blocks")
        bands = classify_blocks(blocks)
        # A Nebeneintrag's parent is only tracked within the same page: an
        # indented entry that happens to be first in its column on a new page
        # would otherwise inherit an unrelated leftover parent from the
        # previous page's last main entry (confirmed happening on p.49->50).
        last_level0 = {"left": None, "right": None}

        for half, base_x, hw_key, ex_key in (
            ("left", LEFT_BASE_X, "left_hw", "left_ex"),
            ("right", RIGHT_BASE_X, "right_hw", "right_ex"),
        ):
            headwords = clean_headwords(bands[hw_key], base_x, warnings, page_num)
            paired = pair_examples(headwords, bands[ex_key])
            paired = apply_known_splits(paired, warnings, page_num)

            for text, level, examples in paired:
                entry = build_entry(text, level, examples, page_num)
                if level == 0:
                    last_level0[half] = entry["headword"]
                else:
                    entry["parent"] = last_level0[half]

                segments = [s.strip() for s in text.split(",")]
                if (
                    len(segments) >= 2
                    and VERB_LAST_SEGMENT_RE.match(segments[-1])
                    and len(segments) != 4
                ):
                    unsplit_verbs.append(f"page {page_num}: {text!r} ({len(segments)} segments)")

                entries.append(entry)

    entries = apply_manual_fixes(entries)

    # Precomputed so static/vocab.js can exact-match search without
    # reimplementing extract_exact_candidates()'s regex rules in JS -- see
    # wordforms.py's module docstring.
    for entry in entries:
        entry["exact_candidates"] = bare_candidate_words(entry["headword"])

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)

    total = len(entries)
    verbs = sum(1 for e in entries if "present_3sg" in e)
    no_example = sum(1 for e in entries if not e["examples"])
    nebeneintrag = sum(1 for e in entries if e["level"] == 1)
    region_tagged = sum(
        1 for e in entries if re.search(r"\((D|A|CH)[,)]", e["headword"])
    )

    print(f"Total entries: {total}")
    print(f"Verbs (fully split into 4 forms): {verbs}")
    print(f"Nebeneintrag (level=1): {nebeneintrag}")
    print(f"Entries with no example: {no_example}")
    print(f"Entries with region tag (D/A/CH): {region_tagged}")
    print(f"Fragment merges: {len(warnings)}")
    print(f"Verb-like entries flagged during parsing (all patched by MANUAL_FIXES): {len(unsplit_verbs)}")
    if warnings:
        print("\n--- fragment merge log ---")
        for w in warnings:
            print(w)
    if unsplit_verbs:
        print("\n--- pre-fix flagged entries (should all be resolved by MANUAL_FIXES) ---")
        for w in unsplit_verbs:
            print(w)

    # Final sanity check: nothing in the output should still look like an
    # unresolved multi-entry merge or a truncated region-tag fragment.
    remaining = []
    for e in entries:
        hw = e["headword"]
        if hw.rstrip().endswith(","):
            remaining.append(f"page {e['page']}: trailing comma {hw!r}")
            continue
        if "present_3sg" not in e:
            segs = [s.strip() for s in hw.split(",")]
            starts_article = hw.startswith(("der ", "die ", "das "))
            has_region = any(t in hw for t in ["(D", "(A", "(CH", "→"])
            if len(segs) >= 2 and not starts_article and not has_region:
                remaining.append(f"page {e['page']}: still suspect {hw!r}")
    print(f"\nRemaining suspect entries after manual fixes: {len(remaining)}")
    for r in remaining:
        print(r)


if __name__ == "__main__":
    main()
