import json
import os

import spacy

from wordforms import extract_exact_candidates, normalize_for_exact_match

_nlp = None

POS_LABELS = {
    "NOUN": "명사",
    "VERB": "동사",
    "ADJ": "형용사",
}

_WORTLISTE_PATH = os.path.join(os.path.dirname(__file__), "static", "goethe_b1_wortliste.json")
_CUSTOM_VOCAB_PATH = os.path.join(os.path.dirname(__file__), "static", "custom_vocab.json")

_meaning_lookup = None

# German nouns are always capitalized while verbs/adjectives are not, so the
# same bare spelling can be a real homonym across POS ("das Unternehmen" the
# company vs. "unternehmen" to undertake) -- meaning lookups are bucketed by
# this category (derived from an article for nouns, present_3sg for verbs, and
# everything else falls to OTHER) so a noun token never picks up a verb's
# meaning, or vice versa.
_CAT_NOUN, _CAT_VERB, _CAT_OTHER = "NOUN", "VERB", "OTHER"


def _token_category(pos_: str) -> str:
    if pos_ == "NOUN":
        return _CAT_NOUN
    if pos_ == "VERB":
        return _CAT_VERB
    return _CAT_OTHER


def _get_nlp():
    global _nlp
    if _nlp is None:
        _nlp = spacy.load("de_core_news_sm")
    return _nlp


def _get_meaning_lookup() -> dict[tuple[str, str], dict]:
    """(bare word lowercased, POS category) -> {"meaning": ..., "artikel": "der"/"die"/"das"/None},
    built once from the B1 Wortliste. Used to show a translation (and, for
    nouns, the article) on article vocab picks that happen to also be B1
    words -- most picks won't be, since the article selection targets
    salient content words, not B1-level ones specifically."""
    global _meaning_lookup
    if _meaning_lookup is None:
        _meaning_lookup = {}
        with open(_WORTLISTE_PATH, encoding="utf-8") as f:
            entries = json.load(f)
        for entry in entries:
            meaning = entry.get("meaning_ko")
            if not meaning:
                continue
            is_verb_entry = "present_3sg" in entry
            for word, article in extract_exact_candidates(entry["headword"]):
                category = _CAT_NOUN if article else (_CAT_VERB if is_verb_entry else _CAT_OTHER)
                key = (normalize_for_exact_match(word), category)
                if key[0] and key not in _meaning_lookup:
                    _meaning_lookup[key] = {"meaning": meaning, "artikel": article}
    return _meaning_lookup


def _get_custom_vocab_lookup() -> dict[tuple[str, str], str]:
    """(bare word lowercased, POS category) -> Korean meaning, from words the
    player has already saved via study mode on a previous article. Reloaded
    on every call (unlike the B1 lookup, which never changes at runtime)
    since this file keeps growing for as long as the server stays up."""
    if not os.path.exists(_CUSTOM_VOCAB_PATH):
        return {}
    with open(_CUSTOM_VOCAB_PATH, encoding="utf-8") as f:
        entries = json.load(f)
    lookup = {}
    for entry in entries:
        headword, meaning, pos = entry.get("headword"), entry.get("meaning_ko"), entry.get("pos")
        if not headword or not meaning or not pos:
            continue
        category = {"명사": _CAT_NOUN, "동사": _CAT_VERB}.get(pos, _CAT_OTHER)
        lookup[(headword.strip().lower(), category)] = meaning
    return lookup


def _is_vocab_token(token) -> bool:
    if (
        token.pos_ not in POS_LABELS
        or not token.is_alpha
        or len(token.text) < 3
        # German capitalizes every noun, not just proper ones, so the POS
        # tagger alone sometimes mislabels a name as NOUN instead of PROPN.
        # Named-entity recognition is a second, independent signal that
        # catches those -- exclude anything tagged as a person/place/org/
        # misc entity regardless of what POS it got.
        or token.ent_type_
    ):
        return False
    # spaCy's German stopword list includes bare "kommt"/"geht" etc. (they're
    # often light verbs, as in "es kommt darauf an"), but that shouldn't
    # disqualify a *separable* verb built on them ("ankommen" is a distinct,
    # meaningful verb) -- only skip the stopword check when there's no
    # separable prefix attached.
    if token.is_stop and _separable_particle(token) is None:
        return False
    return True


def _separable_particle(verb_token):
    """The child token that's this verb's separated-off prefix, if any --
    e.g. the "an" in "Er kommt heute an" (head=kommt, dep=svp)."""
    if verb_token.pos_ != "VERB":
        return None
    return next((c for c in verb_token.children if c.dep_ == "svp"), None)


def _effective_lemma(token) -> str:
    """The lemma to key/display a verb by. A separated separable verb
    ("kommt ... an") is two tokens whose plain lemma is just the bare
    "kommen" -- prefix it back on so it matches spaCy's own lemma for the
    fused forms ("angekommen"/"anzukommen" -> "ankommen"), instead of
    silently losing the prefix and showing the wrong, unrelated verb.
    """
    particle = _separable_particle(token)
    if particle is not None:
        return particle.text.lower() + token.lemma_.strip()
    return token.lemma_.strip()


def _highlight_key(token):
    """The vocab key this token contributes to, for bold-highlighting.
    A separable verb's prefix particle (POS=ADP, dep=svp) doesn't carry a
    verb lemma of its own -- route it to the same combined key as its head
    verb so both halves of a split separable verb light up together.
    """
    if token.pos_ == "VERB":
        return (_effective_lemma(token).lower(), "VERB")
    if token.dep_ == "svp" and token.head.pos_ == "VERB":
        combined = token.text.lower() + token.head.lemma_.strip()
        return (combined.lower(), "VERB")
    return (token.lemma_.strip().lower(), token.pos_)


def annotate(blocks: list[dict], max_words: int = 25) -> tuple[list[dict], list[dict]]:
    """Pick key vocabulary from the article and mark every occurrence of it
    in the body (any inflected form, matched by lemma) so the frontend can
    render it bold. Returns (vocab_list, blocks_with_runs).

    Picks are spread across blocks proportionally to how many candidate
    content words each one has, instead of greedily filling the quota from
    the first paragraph -- otherwise the highlights all cluster at the top
    of the article and the rest reads unmarked. A block that can't fill its
    share (its candidates were already picked earlier, as duplicate lemmas)
    passes the shortfall on to the next block instead of losing it.
    """
    nlp = _get_nlp()
    meaning_lookup = _get_meaning_lookup()
    custom_lookup = _get_custom_vocab_lookup()
    docs = [nlp(b["text"]) for b in blocks]
    weights = [sum(1 for t in doc if _is_vocab_token(t)) for doc in docs]

    vocab: dict[tuple[str, str], dict] = {}
    remaining_budget = max_words
    remaining_weight = sum(weights)
    carry = 0

    for doc, weight in zip(docs, weights):
        if remaining_budget <= 0:
            break

        share = round(remaining_budget * weight / remaining_weight) if remaining_weight > 0 else 0
        quota = min(share + carry, remaining_budget)

        picked = 0
        for token in doc:
            if picked >= quota:
                break
            if not _is_vocab_token(token):
                continue
            lemma = _effective_lemma(token)
            key = (lemma.lower(), token.pos_)
            if key in vocab:
                continue  # already picked from an earlier block -- try another word
            entry = {
                "lemma": lemma,
                "pos": POS_LABELS[token.pos_],
                # The sentence this word is first picked from -- the frontend
                # sends it back on save so a non-B1 word saved to the custom
                # vocab list gets a real in-context example for free, instead
                # of study mode having no way to add one at all.
                "example": token.sent.text.strip(),
            }
            category = _token_category(token.pos_)
            info = meaning_lookup.get((lemma.lower(), category))
            if info:
                # A B1 Wortliste meaning is authoritative -- the frontend
                # locks these from editing. A custom-vocab meaning is the
                # player's own past answer, so it stays editable there.
                entry["meaning_ko"] = info["meaning"]
                entry["locked"] = True
                if token.pos_ == "NOUN" and info["artikel"]:
                    entry["artikel"] = info["artikel"]
            else:
                custom_meaning = custom_lookup.get((lemma.lower(), category))
                if custom_meaning:
                    entry["meaning_ko"] = custom_meaning
            vocab[key] = entry
            picked += 1

        carry = quota - picked
        remaining_budget -= picked
        remaining_weight -= weight

    highlighted_blocks = []
    for block, doc in zip(blocks, docs):
        runs = []
        for token in doc:
            matched = vocab.get(_highlight_key(token))
            run = {"text": token.text_with_ws, "bold": matched is not None}
            if matched:
                # The lemma lets the frontend re-target every occurrence of
                # this word (which vary in surface form -- "Kontrolle" vs.
                # "Kontrollen") after the player saves a meaning for it mid-
                # article, without having to re-fetch or re-render the body.
                run["lemma"] = matched["lemma"]
                if matched.get("meaning_ko"):
                    run["meaning_ko"] = matched["meaning_ko"]
            runs.append(run)
        highlighted_blocks.append({"type": block["type"], "runs": runs})

    return list(vocab.values()), highlighted_blocks
