import json
import os
import re
import uuid
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request, send_from_directory

from crawler import fetch_random_article
from vocab import annotate
from wordforms import bare_candidate_words

app = Flask(__name__)

CUSTOM_VOCAB_PATH = os.path.join(app.root_path, "static", "custom_vocab.json")
CUSTOM_EXT_VOCAB_PATH = os.path.join(app.root_path, "static", "custom_ext_vocab.json")
SAVED_ARTICLES_DIR = os.path.join(app.root_path, "gespeicherte Artikel")


def _load_custom_vocab() -> list[dict]:
    if not os.path.exists(CUSTOM_VOCAB_PATH):
        return []
    with open(CUSTOM_VOCAB_PATH, encoding="utf-8") as f:
        return json.load(f)


def _save_custom_vocab(entries: list[dict]) -> None:
    with open(CUSTOM_VOCAB_PATH, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)


def _load_custom_ext_vocab() -> list[dict]:
    if not os.path.exists(CUSTOM_EXT_VOCAB_PATH):
        return []
    with open(CUSTOM_EXT_VOCAB_PATH, encoding="utf-8") as f:
        return json.load(f)


def _save_custom_ext_vocab(entries: list[dict]) -> None:
    with open(CUSTOM_EXT_VOCAB_PATH, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/vocab")
def vocab_page():
    return render_template("vocab.html")


@app.route("/quiz")
def quiz_page():
    return render_template("quiz.html")


@app.route("/my-vocab")
def my_vocab_page():
    return render_template("my_vocab.html")


def _parse_ext_vocab_fields(payload: dict) -> dict | None:
    headword = (payload.get("headword") or "").strip()
    meaning = (payload.get("meaning_ko") or "").strip()
    if not headword or not meaning:
        return None

    examples = [e.strip() for e in (payload.get("examples") or []) if isinstance(e, str) and e.strip()]
    return {
        "headword": headword,
        "pos": (payload.get("pos") or "").strip(),
        "meaning_ko": meaning,
        "examples": examples,
        "present_3sg": (payload.get("present_3sg") or "").strip(),
        "preterite": (payload.get("preterite") or "").strip(),
        "perfect": (payload.get("perfect") or "").strip(),
    }


@app.route("/api/my-vocab", methods=["POST"])
def add_my_vocab():
    fields = _parse_ext_vocab_fields(request.get_json(silent=True) or {})
    if fields is None:
        return jsonify({"error": "headword and meaning_ko required"}), 400

    entry = {
        "id": uuid.uuid4().hex[:12],
        **fields,
        "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    entries = _load_custom_ext_vocab()
    entries.append(entry)
    _save_custom_ext_vocab(entries)
    return jsonify(entry), 201


@app.route("/api/my-vocab/<entry_id>", methods=["PUT"])
def update_my_vocab(entry_id):
    fields = _parse_ext_vocab_fields(request.get_json(silent=True) or {})
    if fields is None:
        return jsonify({"error": "headword and meaning_ko required"}), 400

    entries = _load_custom_ext_vocab()
    for entry in entries:
        if entry.get("id") == entry_id:
            entry.update(fields)
            _save_custom_ext_vocab(entries)
            return jsonify(entry)

    return jsonify({"error": "not found"}), 404


@app.route("/api/my-vocab/<entry_id>", methods=["DELETE"])
def delete_my_vocab(entry_id):
    entries = _load_custom_ext_vocab()
    remaining = [e for e in entries if e.get("id") != entry_id]
    if len(remaining) == len(entries):
        return jsonify({"error": "not found"}), 404

    _save_custom_ext_vocab(remaining)
    return jsonify({"deleted": entry_id})


@app.route("/api/custom-vocab", methods=["POST"])
def save_custom_vocab():
    payload = request.get_json(silent=True) or {}
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        return jsonify({"error": "items required"}), 400

    entries = _load_custom_vocab()
    # Keyed by (headword, pos) so re-saving a word (e.g. from a later article)
    # updates its meaning in place instead of piling up duplicates -- pos is
    # part of the key so a noun/verb homonym pair (e.g. "Essen"/"essen")
    # don't clobber each other's saved meaning.
    by_key = {(e["headword"].lower(), e.get("pos", "")): e for e in entries}

    saved = 0
    for item in items:
        headword = (item.get("headword") or "").strip()
        meaning = (item.get("meaning_ko") or "").strip()
        pos = (item.get("pos") or "").strip()
        example = (item.get("example") or "").strip()
        if not headword or not meaning:
            continue

        key = (headword.lower(), pos)
        existing = by_key.get(key)
        # One example per word, set on first save only -- a later re-save
        # (e.g. the same word turns up unlocked in a different article) must
        # not replace it, since the example is what anchors this specific
        # in-context first encounter.
        examples = list(existing["examples"]) if existing and existing.get("examples") else []
        if not examples and example:
            examples = [example]

        by_key[key] = {
            "headword": headword,
            "pos": pos,
            "meaning_ko": meaning,
            "examples": examples,
            "exact_candidates": bare_candidate_words(headword),
            "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        saved += 1

    _save_custom_vocab(list(by_key.values()))
    return jsonify({"saved": saved})


@app.route("/api/custom-vocab/example", methods=["DELETE"])
def delete_custom_vocab_example():
    headword = (request.args.get("headword") or "").strip()
    pos = (request.args.get("pos") or "").strip()
    if not headword:
        return jsonify({"error": "headword required"}), 400

    entries = _load_custom_vocab()
    for entry in entries:
        if entry.get("headword", "").lower() == headword.lower() and entry.get("pos", "") == pos:
            entry["examples"] = []
            _save_custom_vocab(entries)
            return jsonify(entry)

    return jsonify({"error": "not found"}), 404


def _safe_saved_filename(name: str) -> str:
    name = os.path.basename((name or "").strip().replace("\\", "/"))
    name = re.sub(r'[\\/:*?"<>|]', "", name).strip()
    if not name.lower().endswith(".html"):
        name += ".html"
    return name or "article.html"


@app.route("/api/save-article", methods=["POST"])
def save_article():
    payload = request.get_json(silent=True) or {}
    html = payload.get("html")
    if not html:
        return jsonify({"error": "html required"}), 400

    filename = _safe_saved_filename(payload.get("filename"))
    os.makedirs(SAVED_ARTICLES_DIR, exist_ok=True)
    with open(os.path.join(SAVED_ARTICLES_DIR, filename), "w", encoding="utf-8") as f:
        f.write(html)
    return jsonify({"filename": filename})


@app.route("/api/saved-articles")
def list_saved_articles():
    if not os.path.isdir(SAVED_ARTICLES_DIR):
        return jsonify([])

    articles = []
    for name in os.listdir(SAVED_ARTICLES_DIR):
        if not name.lower().endswith(".html"):
            continue
        stem = name[:-5]
        date, _, title = stem.partition("_")
        articles.append({"filename": name, "date": date, "title": title or stem})

    articles.sort(key=lambda a: (a["date"], a["filename"]), reverse=True)
    return jsonify(articles)


@app.route("/gespeicherte-artikel/<path:filename>")
def saved_article(filename):
    return send_from_directory(SAVED_ARTICLES_DIR, filename)


@app.route("/api/random-article")
def random_article():
    try:
        article = fetch_random_article()
        vocab, blocks = annotate(article["blocks"])
        article["vocab"] = vocab
        article["blocks"] = blocks
        return jsonify(article)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    # host="0.0.0.0" so it's reachable over Tailscale, not just from this PC.
    # debug=False because the Werkzeug debugger is a remote-code-execution
    # risk once the server is reachable from another device.
    app.run(host="0.0.0.0", port=5000, debug=False)
