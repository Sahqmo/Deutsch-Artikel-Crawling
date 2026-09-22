import random
import re

import feedparser
import requests
import trafilatura

RSS_URL = "https://www.zdfheute.de/rss/zdf/nachrichten"
USER_AGENT = "Mozilla/5.0 (compatible; DeutschLernBot/0.1; personal language-learning use)"
MAX_ATTEMPTS = 5
MIN_WORD_COUNT = 40  # skip landing pages / JS-only stubs with barely any real text

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
NUMBERED_LIST_RE = re.compile(r"^\d+\.\s+")  # related-article teaser items are always numbered
DASH_BULLET_RE = re.compile(r"^-\s+")  # real in-article bullet points use "- "
VIDEO_CAPTION_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}\s*\|\s*\d+:\d+\s*min$")
ITALIC_LINE_RE = re.compile(r"^\*.+\*$")  # whole-line italics: author credit trailer
STRAY_SYMBOL_RE = re.compile(r"^[|>*_-]+$")  # leftover markdown table/quote artifacts
BYLINE_RE = re.compile(r"^[Vv]on\s+[A-ZÄÖÜ]")
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")  # markdown emphasis left in mid-text
ITALIC_INLINE_RE = re.compile(r"\*(.+?)\*")  # e.g. interview speaker labels, quoted terms

# ZDF's "related links" / CTA footer labels (e.g. "Weitere Nachrichten aus ...",
# "Mehr zum Thema ...", "Mehr aktuelle News", "Ähnliche Inhalte entdecken",
# the newsletter plug). Narrow enough that a real sentence like "Mehr als 100
# Demonstranten wurden festgenommen" won't match.
FOOTER_LABEL_RE = re.compile(
    r"^(Weitere\b|Mehr (zum|zur|zu|aktuelle)\b|Ähnliche (Inhalte|Themen)\b"
    r"|Das könnte (Sie|dich) auch interessieren|Keine Zeit für endlose Nachrichtenfeeds)"
)


def fetch_random_article() -> dict:
    feed = feedparser.parse(RSS_URL)
    if not feed.entries:
        raise RuntimeError("RSS 피드를 불러오지 못했습니다.")

    candidates = list(feed.entries)
    random.shuffle(candidates)

    for entry in candidates[:MAX_ATTEMPTS]:
        article = _extract_article(entry)
        if article is not None:
            return article

    raise RuntimeError("본문을 추출할 수 있는 기사를 찾지 못했습니다. 다시 시도해 주세요.")


def _extract_article(entry) -> dict | None:
    response = requests.get(entry.link, headers={"User-Agent": USER_AGENT}, timeout=10)
    if not response.ok:
        return None

    markdown = trafilatura.extract(
        response.text,
        include_comments=False,
        include_tables=False,
        favor_precision=True,
        output_format="markdown",
    )
    if not markdown:
        return None

    blocks = _parse_blocks(markdown)
    blocks = _clean_blocks(blocks, entry.title)
    if not blocks:
        return None

    word_count = sum(len(b["text"].split()) for b in blocks if b["type"] == "paragraph")
    if word_count < MIN_WORD_COUNT:
        return None  # too short to be a real article (landing page, video stub, ...)

    return {
        "title": entry.title,
        "url": entry.link,
        "published": getattr(entry, "published", ""),
        "blocks": blocks,
    }


def _parse_blocks(markdown: str) -> list[dict]:
    blocks = []
    for raw_line in markdown.split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        if NUMBERED_LIST_RE.match(line):
            continue  # related-article teaser link, e.g. "1. ### Titel ...mit Video9:59"

        heading = HEADING_RE.match(line)
        if heading:
            text = heading.group(2).strip()
            if text:
                blocks.append({"type": "heading", "text": text})
            continue

        line = DASH_BULLET_RE.sub("", line).strip()
        if line:
            blocks.append({"type": "paragraph", "text": line})

    return blocks


def _clean_blocks(blocks: list[dict], title: str) -> list[dict]:
    # The page repeats its own headline (often as "Kicker:Titel") and,
    # separately, a "von <Autor>" byline, before the real body starts.
    while blocks and _is_title_dupe(blocks[0]["text"], title):
        blocks = blocks[1:]
    if blocks and blocks[0]["type"] == "paragraph" and _is_byline(blocks[0]["text"]):
        blocks = blocks[1:]

    cleaned = []
    for block in blocks:
        text = block["text"]
        if block["type"] == "paragraph" and (
            VIDEO_CAPTION_RE.match(text)
            or ITALIC_LINE_RE.match(text)
            or STRAY_SYMBOL_RE.match(text)
            or _is_byline(text)
            or ("{{" in text and "}}" in text)
        ):
            continue
        cleaned.append({"type": block["type"], "text": _strip_markdown_emphasis(text)})

    # A "Weitere ..." / "Mehr zu ..." heading always marks the start of the
    # related-links footer -- keep everything before it, drop the rest.
    for i, block in enumerate(cleaned):
        if block["type"] == "heading" and FOOTER_LABEL_RE.match(block["text"]):
            cleaned = cleaned[:i]
            break

    # Some footer/CTA blocks ("Ähnliche Inhalte entdecken", the newsletter
    # plug, ...) render as a plain trailing paragraph instead of a heading,
    # so trim those off the tail too.
    while cleaned and FOOTER_LABEL_RE.match(cleaned[-1]["text"]):
        cleaned.pop()

    return cleaned


def _is_title_dupe(text: str, title: str) -> bool:
    if not title:
        return False
    text_l, title_l = text.strip().lower(), title.strip().lower()
    return title_l in text_l or text_l in title_l


def _strip_markdown_emphasis(text: str) -> str:
    # trafilatura's markdown output leaves "**bold**"/"*italic*" markers in
    # the text itself (e.g. "**Andreas Wiemers**: ..." for interview
    # speaker labels, or "*umfassend geprüft*" around a quoted term) --
    # drop the asterisks but keep the wrapped words. Bold (**) first, since
    # its pairs would otherwise confuse the single-asterisk pattern.
    text = BOLD_RE.sub(r"\1", text)
    return ITALIC_INLINE_RE.sub(r"\1", text)


def _is_byline(text: str) -> bool:
    # A short "von <Name>[, <Ort>]" line with no sentence-ending punctuation
    # is reliably a byline, not body prose (which would run past ~60 chars
    # or end in a period/question mark).
    return bool(BYLINE_RE.match(text)) and len(text) < 60 and not re.search(r"[.!?]", text)
