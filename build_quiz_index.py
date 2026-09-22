"""Build the fill-in-the-blank quiz question pool from the Wortliste's example
sentences.

For each (headword, example) pair, tries to locate the token(s) in the example
that spaCy's lemmatizer resolves back to that headword (reusing vocab.py's
separable-verb lemma logic, so "Er zieht heute ein." is correctly matched
against headword "einziehen" across its two split tokens). Only pairs where a
match is actually found become quiz questions -- an example whose inflected
form can't be confidently traced back to the headword (irregular participle
the lemmatizer mis-tags, a bound prefix like "Elektro-" that never appears as
its own token, etc.) is silently skipped rather than shipped as a
broken/unanswerable question.

Usage: python build_quiz_index.py
Output: static/quiz_index.json
"""

import json
import re
import sys
from pathlib import Path

import spacy

from vocab import _effective_lemma, _separable_particle

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

WORTLISTE_PATH = Path("static/goethe_b1_wortliste.json")
OUTPUT_PATH = Path("static/quiz_index.json")

# Mirrors static/vocab.js's extractExactCandidates(): strip the leading
# article and any parenthetical/cross-reference note to get the bare
# noun(s); non-nouns fall back to their comma-separated segments.
PAREN_RE = re.compile(r"\([^)]*\)")
ARTICLE_RE = re.compile(r"\b(?:der|die|das)\s+([A-ZÄÖÜ][^\s,;()/]*)")
SLASH_PAIR_RE = re.compile(r"([^\s,;()/]+)/([^\s,;()/]+)")
ARTICLE_WORD_RE = re.compile(r"^(der|die|das)$", re.IGNORECASE)
SICH_RE = re.compile(r"^sich\s+", re.IGNORECASE)


def extract_candidates(headword: str) -> list[str]:
    s = PAREN_RE.sub(" ", headword)
    s = s.split("→")[0].strip()

    candidates = [m.group(1) for m in ARTICLE_RE.finditer(s)]

    if not candidates:
        for seg in s.split(","):
            seg = seg.strip()
            if seg:
                candidates.append(SICH_RE.sub("", seg))

    for m in SLASH_PAIR_RE.finditer(s):
        left, right = m.group(1), m.group(2)
        if not ARTICLE_WORD_RE.match(left) and not ARTICLE_WORD_RE.match(right):
            candidates.append(left)
            candidates.append(right)

    expanded = []
    for c in candidates:
        for part in c.split("/"):
            part = part.strip()
            if part:
                expanded.append(part)
    return expanded


def normalize(s: str) -> str:
    return s.strip().lower().strip("-")


def find_match_span(doc, candidate_set):
    for token in doc:
        if token.pos_ == "VERB":
            lemma = _effective_lemma(token)
        else:
            lemma = token.lemma_
        if normalize(lemma) in candidate_set:
            span = [token.i]
            particle = _separable_particle(token)
            if particle is not None:
                span.append(particle.i)
            return sorted(span)
    return None


def answer_leaks_elsewhere(doc, span_indices, answer_words) -> bool:
    """True if some token outside the blanked span is literally the same
    word as (part of) the answer -- e.g. "Schritt für Schritt", "Ja, ja" --
    which would hand the answer to the player for free."""
    span_set = set(span_indices)
    return any(
        token.i not in span_set and token.text.lower() in answer_words
        for token in doc
    )


def build_blanked_sentence(doc, span_indices) -> str:
    span_set = set(span_indices)
    parts = [
        "______" + token.whitespace_ if token.i in span_set else token.text_with_ws
        for token in doc
    ]
    return "".join(parts)


def main():
    print("loading spaCy model...")
    nlp = spacy.load("de_core_news_sm")
    data = json.loads(WORTLISTE_PATH.read_text(encoding="utf-8"))

    questions = []
    total_examples = 0
    matched = 0
    skipped_no_candidates = 0
    skipped_leak = 0

    for entry in data:
        headword = entry["headword"]
        candidates = extract_candidates(headword)
        candidate_set = {normalize(c) for c in candidates}
        examples = entry.get("examples") or []
        if not candidate_set:
            skipped_no_candidates += len(examples)
            continue
        for example in examples:
            total_examples += 1
            doc = nlp(example)
            span = find_match_span(doc, candidate_set)
            if span is None:
                continue
            answer = " ".join(doc[i].text for i in span)
            answer_words = {w.lower() for w in answer.split()}
            if answer_leaks_elsewhere(doc, span, answer_words):
                skipped_leak += 1
                continue
            matched += 1
            sentence = build_blanked_sentence(doc, span)
            # German capitalizes every noun regardless of sentence position,
            # so a noun answer's case is a real spelling rule worth enforcing.
            # A non-noun answer's capital only ever comes from it starting the
            # sentence -- that's a sentence-position artifact, not something
            # about the word itself, so don't penalize the player for typing
            # it lowercase.
            case_sensitive = doc[span[0]].pos_ == "NOUN"
            questions.append(
                {
                    "headword": headword,
                    "page": entry.get("page"),
                    "sentence": sentence,
                    "answer": answer,
                    "meaning_ko": entry.get("meaning_ko"),
                    "case_sensitive": case_sensitive,
                }
            )

    OUTPUT_PATH.write_text(
        json.dumps(questions, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    rate = matched / total_examples if total_examples else 0
    print(f"{matched}/{total_examples} examples matched ({rate:.1%})")
    print(f"{skipped_no_candidates} examples skipped (no extractable candidate word)")
    print(f"{skipped_leak} matches skipped (answer word recurs elsewhere in the sentence)")
    print(f"wrote {len(questions)} quiz questions to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
