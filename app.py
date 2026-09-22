import json
import os
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request

from crawler import fetch_random_article
from vocab import annotate

app = Flask(__name__)

CUSTOM_VOCAB_PATH = os.path.join(app.root_path, "static", "custom_vocab.json")


def _load_custom_vocab() -> list[dict]:
    if not os.path.exists(CUSTOM_VOCAB_PATH):
        return []
    with open(CUSTOM_VOCAB_PATH, encoding="utf-8") as f:
        return json.load(f)


def _save_custom_vocab(entries: list[dict]) -> None:
    with open(CUSTOM_VOCAB_PATH, "w", encoding="utf-8") as f:
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


@app.route("/api/custom-vocab", methods=["POST"])
def save_custom_vocab():
    payload = request.get_json(silent=True) or {}
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        return jsonify({"error": "items required"}), 400

    entries = _load_custom_vocab()
    # Keyed by headword so re-saving a word (e.g. from a later article) updates
    # its meaning in place instead of piling up duplicates.
    by_headword = {e["headword"].lower(): e for e in entries}

    saved = 0
    for item in items:
        headword = (item.get("headword") or "").strip()
        meaning = (item.get("meaning_ko") or "").strip()
        if not headword or not meaning:
            continue
        by_headword[headword.lower()] = {
            "headword": headword,
            "pos": (item.get("pos") or "").strip(),
            "meaning_ko": meaning,
            "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        saved += 1

    _save_custom_vocab(list(by_headword.values()))
    return jsonify({"saved": saved})


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
