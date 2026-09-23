"""Shared headword -> exact-match-candidate extraction.

This is the single source of truth for reducing a Wortliste-style headword
(e.g. "die Abbildung, -en", "unternehmen", "Glace/Glacé") to its bare,
comparable word form(s) -- stripping articles, plural-marker/regional-note
tails, and splitting gender pairs and slash-joined alternate spellings into
separate candidates.

static/vocab.js needs this same reduction to support exact-word-match search
on the /vocab page, but has no access to a Python import -- so instead of
maintaining a second, hand-translated copy of these regexes in JavaScript
(which would silently drift from this one the next time the rules change),
the candidates are precomputed here and serialized into the "exact_candidates"
field of each entry written to static/goethe_b1_wortliste.json (by
scripts/parse_b1_wortliste.py) and static/custom_vocab.json (by app.py). vocab.js just
reads that field.
"""

import re

_PAREN_RE = re.compile(r"\([^)]*\)")
_ARTICLE_RE = re.compile(r"\b(der|die|das)\s+([A-ZÄÖÜ][^\s,;()/]*)")
_SLASH_PAIR_RE = re.compile(r"([^\s,;()/]+)/([^\s,;()/]+)")
_ARTICLE_WORD_RE = re.compile(r"^(der|die|das)$", re.IGNORECASE)


def extract_exact_candidates(headword: str) -> list[tuple[str, str | None]]:
    """Reduce a headword to its bare, comparable word form(s). Each candidate
    carries the article it was found under ("der"/"die"/"das"), or None when
    the headword had none (verbs, adjectives, slash-pair halves that weren't
    captured directly after an article).
    """
    s = _PAREN_RE.sub(" ", headword)
    s = s.split("→")[0].strip()

    candidates: list[tuple[str, str | None]] = []
    candidates.extend((m.group(2), m.group(1).lower()) for m in _ARTICLE_RE.finditer(s))

    if not candidates:
        candidates.extend((seg.strip(), None) for seg in s.split(",") if seg.strip())

    for m in _SLASH_PAIR_RE.finditer(s):
        left, right = m.group(1), m.group(2)
        if not _ARTICLE_WORD_RE.match(left) and not _ARTICLE_WORD_RE.match(right):
            candidates.append((left, None))
            candidates.append((right, None))

    expanded = []
    for word, article in candidates:
        for part in word.split("/"):
            part = part.strip()
            if part:
                expanded.append((part, article))
    return expanded


def normalize_for_exact_match(s: str) -> str:
    return s.strip().lower().strip("-")


def bare_candidate_words(headword: str) -> list[str]:
    """Just the candidate words (no article), for serializing into a JSON
    entry's "exact_candidates" field."""
    return sorted({word for word, _ in extract_exact_candidates(headword)})
