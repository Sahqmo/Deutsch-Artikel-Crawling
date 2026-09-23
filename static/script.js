const btn = document.getElementById("load-btn");
const content = document.getElementById("content");
const studyToggle = document.getElementById("study-toggle");
const loadSavedBtn = document.getElementById("load-saved-btn");
const savedArticlesOverlay = document.getElementById("saved-articles-overlay");
const savedArticlesList = document.getElementById("saved-articles-list");
const savedArticlesEmpty = document.getElementById("saved-articles-empty");
const closeSavedOverlayBtn = document.getElementById("close-saved-overlay-btn");

let currentArticle = null;

loadSavedBtn.addEventListener("click", openSavedArticlesOverlay);
closeSavedOverlayBtn.addEventListener("click", closeSavedArticlesOverlay);
savedArticlesOverlay.addEventListener("click", (event) => {
  if (event.target === savedArticlesOverlay) closeSavedArticlesOverlay();
});

async function openSavedArticlesOverlay() {
  savedArticlesOverlay.hidden = false;
  savedArticlesList.innerHTML = "";
  savedArticlesEmpty.hidden = true;

  try {
    const res = await fetch("/api/saved-articles");
    const articles = await res.json();
    if (!res.ok) throw new Error(articles.error || "목록을 불러오지 못했습니다.");

    if (articles.length === 0) {
      savedArticlesEmpty.hidden = false;
      return;
    }

    savedArticlesList.innerHTML = articles
      .map(
        (a) => `
        <li>
          <a href="/gespeicherte-artikel/${encodeURIComponent(a.filename)}">
            <span class="saved-date">${escapeHtml(a.date)}</span>${escapeHtml(a.title)}
          </a>
        </li>
      `
      )
      .join("");
  } catch (err) {
    savedArticlesList.innerHTML = `<li class="error">오류: ${escapeHtml(err.message)}</li>`;
  }
}

function closeSavedArticlesOverlay() {
  savedArticlesOverlay.hidden = true;
}

studyToggle.addEventListener("click", () => {
  const active = document.body.classList.toggle("study-mode");
  studyToggle.classList.toggle("active", active);
  studyToggle.setAttribute("aria-pressed", String(active));
});

content.addEventListener("input", (event) => {
  if (event.target.classList.contains("memo-box")) {
    autoResize(event.target);
  }
});

btn.addEventListener("click", async () => {
  btn.disabled = true;
  content.innerHTML = renderSkeleton();

  try {
    const res = await fetch("/api/random-article");
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "알 수 없는 오류");
    }

    currentArticle = data;
    renderArticle(data);
  } catch (err) {
    currentArticle = null;
    content.innerHTML = `<p class="error">오류: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

content.addEventListener("click", (event) => {
  if (event.target.id === "save-link" && currentArticle) {
    saveArticleAsHtml(currentArticle);
  }
  if (event.target.id === "save-vocab-btn") {
    saveCustomVocab();
  }
});

// A shimmering placeholder shaped like an article (title bar, meta bar, a
// handful of paragraphs, a row of vocab pills) instead of a plain "loading"
// line, so the wait looks like the page filling in rather than a blank stall.
// Bars cascade in one by one rather than all appearing at once -- lines
// within a paragraph pop in quickly, with a slightly longer breath between
// paragraphs, so it reads as "the article taking shape" rather than a flat
// uniform tick.
function renderSkeleton() {
  const STEP_MS = 50;
  const PARAGRAPH_GAP_MS = 90;

  let delay = 0;
  const nextDelay = () => {
    const d = delay;
    delay += STEP_MS;
    return d;
  };
  const bar = (cls, width, unit = "%") =>
    `<div class="skeleton-line${cls ? " " + cls : ""}" style="width:${width}${unit}; animation-delay:${nextDelay()}ms"></div>`;

  const titleBar = bar("skeleton-title", 70);
  const metaBar = bar("skeleton-meta", 35);

  const paragraphs = Array.from({ length: 4 + Math.floor(Math.random() * 2) }, () => {
    delay += PARAGRAPH_GAP_MS;
    const lineCount = 2 + Math.floor(Math.random() * 3);
    const lines = Array.from({ length: lineCount }, (_, i) => {
      const isLast = i === lineCount - 1;
      const width = isLast ? 35 + Math.floor(Math.random() * 30) : 90 + Math.floor(Math.random() * 10);
      return bar("", width);
    }).join("");
    return `<div class="skeleton-paragraph">${lines}</div>`;
  }).join("");

  delay += PARAGRAPH_GAP_MS;
  const vocabHeadingBar = bar("skeleton-vocab-heading", 22);

  const pills = Array.from(
    { length: 8 },
    () => `<div class="skeleton-pill" style="width:${50 + Math.floor(Math.random() * 50)}px; animation-delay:${nextDelay()}ms"></div>`
  ).join("");

  return `
    <div class="skeleton" role="status" aria-live="polite">
      <span class="sr-only">기사를 불러오는 중입니다</span>
      ${titleBar}
      ${metaBar}
      ${paragraphs}
      ${vocabHeadingBar}
      <div class="skeleton-vocab">${pills}</div>
    </div>
  `;
}

function renderArticle(data) {
  content.innerHTML = `
    <article>
      <h2>${escapeHtml(data.title)}</h2>
      <p class="meta">
        <a href="${data.url}" target="_blank" rel="noopener">원문 보기</a> ·
        <button type="button" id="save-link" class="save-link">저장</button>
        <span id="save-status" class="vocab-save-status"></span> ·
        ${escapeHtml(data.published)}
      </p>
      ${buildBodyHtml(data.blocks, { editable: true })}
    </article>
    <section class="vocab">
      <h3>주요 단어</h3>
      <p class="vocab-save-row">
        <button type="button" id="save-vocab-btn" class="save-link">단어장에 저장</button>
        <span id="vocab-save-status" class="vocab-save-status"></span>
      </p>
      <ul class="vocab-pills">${buildVocabHtml(data.vocab)}</ul>
      <ul class="vocab-study-list">${buildVocabStudyHtml(data.vocab)}</ul>
    </section>
  `;
}

// r.text is spaCy's text_with_ws (the token plus any whitespace that follows
// it) -- split that off before wrapping in <strong>, so the underline/hover
// area for a tooltipped word doesn't bleed into the gap before the next word.
function buildRunHtml(r) {
  if (!r.bold) return escapeHtml(r.text);
  const [, word, trailing] = r.text.match(/^(\S*)(\s*)$/) || [null, r.text, ""];
  const lemmaAttr = r.lemma ? ` data-lemma="${escapeHtml(r.lemma)}"` : "";
  const tag = r.meaning_ko
    ? `<strong class="vocab-hl"${lemmaAttr} data-tooltip="${escapeHtml(r.meaning_ko)}">${escapeHtml(word)}</strong>`
    : `<strong${lemmaAttr}>${escapeHtml(word)}</strong>`;
  return tag + escapeHtml(trailing);
}

// Each paragraph gets a translation/note box right below it -- editable
// (a live textarea) while browsing, or a read-only note (skipped if empty)
// once exported to a standalone saved page.
function buildBodyHtml(blocks, { editable = false, memos = {} } = {}) {
  return blocks
    .map((b, i) => {
      const inner = b.runs.map(buildRunHtml).join("");

      if (b.type === "heading") {
        return `<h3>${inner}</h3>`;
      }

      let memoHtml = "";
      if (editable) {
        memoHtml = `<textarea class="memo-box" data-block-index="${i}" rows="2" placeholder="번역이나 메모를 적어보세요"></textarea>`;
      } else if (memos[i]) {
        memoHtml = `<div class="memo-note"><p>${escapeHtml(memos[i])}</p></div>`;
      }

      return `<p>${inner}</p>${memoHtml}`;
    })
    .join("");
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Reads whatever the user typed into the memo boxes, but only while study
// mode is on -- otherwise the saved page comes out exactly as before.
function collectMemos() {
  const memos = {};
  if (!document.body.classList.contains("study-mode")) {
    return memos;
  }
  content.querySelectorAll(".memo-box").forEach((el) => {
    const text = el.value.trim();
    if (text) {
      memos[el.dataset.blockIndex] = text;
    }
  });
  return memos;
}

function vocabDisplayLemma(v) {
  return v.artikel ? `${v.artikel} ${v.lemma}` : v.lemma;
}

function buildVocabHtml(vocab) {
  return vocab
    .map((v) => {
      const displayLemma = vocabDisplayLemma(v);
      const meaning = v.meaning_ko
        ? `<span class="vocab-meaning">${escapeHtml(v.meaning_ko)}</span>`
        : "";
      return `<li><span class="lemma">${escapeHtml(displayLemma)}</span> <span class="pos">${escapeHtml(v.pos)}</span>${meaning}</li>`;
    })
    .join("");
}

// Study mode's fill-in-your-own-meaning view: one word per row (full width),
// a blank input beside it. A word already matched against the B1 Wortliste
// has an authoritative meaning (server-flagged "locked"), so its input just
// displays that, disabled -- no point redoing it. A word matched against the
// player's own saved custom vocab (or just saved this session) pre-fills the
// same way but stays editable, since it's their own answer and they may want
// to correct or improve it later.
function buildVocabStudyHtml(vocab) {
  return vocab
    .map((v) => {
      const displayLemma = vocabDisplayLemma(v);
      let inputAttrs;
      if (v.locked) {
        inputAttrs = `value="${escapeHtml(v.meaning_ko)}" disabled`;
      } else if (v.meaning_ko) {
        inputAttrs = `value="${escapeHtml(v.meaning_ko)}"`;
      } else {
        inputAttrs = `placeholder="뜻 입력..."`;
      }
      return `
        <li class="vocab-study-item">
          <span class="word-info"><span class="lemma">${escapeHtml(displayLemma)}</span> <span class="pos">${escapeHtml(v.pos)}</span></span>
          <input type="text" class="vocab-meaning-input" autocomplete="off" ${inputAttrs} />
        </li>
      `;
    })
    .join("");
}

// Reads the lemma/pos back from the DOM (rather than a data-* attribute)
// so nothing needs a second, attribute-safe escaping pass. The example
// sentence, though, comes straight from currentArticle.vocab (it's never
// rendered into the DOM) -- vocab.py stamps every pick with the sentence it
// first appeared in, so a newly-saved word gets a real in-context example.
function collectVocabStudyEntries() {
  const items = [];
  content.querySelectorAll(".vocab-study-item").forEach((li) => {
    const input = li.querySelector(".vocab-meaning-input");
    if (input.disabled) return; // already has an authoritative B1 meaning
    const meaning = input.value.trim();
    if (!meaning) return;
    const headword = li.querySelector(".lemma").textContent.trim();
    const pos = li.querySelector(".pos").textContent.trim();
    const source = currentArticle
      ? currentArticle.vocab.find((v) => vocabDisplayLemma(v) === headword && v.pos === pos)
      : null;
    items.push({
      headword,
      pos,
      meaning_ko: meaning,
      example: source ? source.example || "" : "",
    });
  });
  return items;
}

async function saveCustomVocab() {
  const statusEl = document.getElementById("vocab-save-status");
  const items = collectVocabStudyEntries();
  if (items.length === 0) {
    if (statusEl) statusEl.textContent = "입력한 뜻이 없습니다.";
    return;
  }

  try {
    const res = await fetch("/api/custom-vocab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "저장 실패");
    applySavedMeanings(items);
    if (statusEl) statusEl.textContent = `${data.saved}개 저장했습니다.`;
  } catch (err) {
    if (statusEl) statusEl.textContent = `오류: ${err.message}`;
  }
}

// Reflects just-saved meanings into the current article's data and
// re-renders both vocab views, so turning study mode back off immediately
// shows the meaning (instead of only after the next article fetch), and the
// just-saved word's study-mode input locks the same way a B1 match's does.
// Also patches the body's highlighted occurrences of that word in place
// (rather than re-rendering the whole article) so any text already typed
// into the study-mode memo boxes survives.
function applySavedMeanings(items) {
  if (!currentArticle) return;
  const byHeadword = new Map(items.map((it) => [it.headword, it.meaning_ko]));

  currentArticle.vocab.forEach((v) => {
    const saved = byHeadword.get(vocabDisplayLemma(v));
    if (saved) v.meaning_ko = saved;
  });

  currentArticle.blocks.forEach((b) => {
    b.runs.forEach((r) => {
      if (r.bold && r.lemma && byHeadword.has(r.lemma)) {
        r.meaning_ko = byHeadword.get(r.lemma);
      }
    });
  });

  const section = content.querySelector("section.vocab");
  if (section) {
    const pillsEl = section.querySelector(".vocab-pills");
    const studyEl = section.querySelector(".vocab-study-list");
    if (pillsEl) pillsEl.innerHTML = buildVocabHtml(currentArticle.vocab);
    if (studyEl) studyEl.innerHTML = buildVocabStudyHtml(currentArticle.vocab);
  }

  content.querySelectorAll("article strong[data-lemma]").forEach((el) => {
    const meaning = byHeadword.get(el.dataset.lemma);
    if (!meaning) return;
    el.classList.add("vocab-hl");
    el.dataset.tooltip = meaning;
  });
}

// Saves straight into the "gespeicherte Artikel" folder on the server
// (rather than a browser download the user then has to move there by hand).
async function saveArticleAsHtml(data) {
  const statusEl = document.getElementById("save-status");
  const memos = collectMemos();
  const html = buildStandaloneHtml(data, memos);
  const filename = `${slugifyFilename(data.title)}.html`;

  if (statusEl) statusEl.textContent = " 저장 중...";
  try {
    const res = await fetch("/api/save-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, html }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "저장 실패");
    if (statusEl) statusEl.textContent = ` 저장됨: ${result.filename}`;
  } catch (err) {
    if (statusEl) statusEl.textContent = ` 오류: ${err.message}`;
  }
}

function buildStandaloneHtml(data, memos = {}) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)}</title>
<style>
  :root { color-scheme: light dark; --fg:#1c1c1c; --bg:#fafafa; --muted:#6b6b6b; --accent:#e07b1e; --border:#e0e0e0; --note-bg:#fbe8d3; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --bg:#181818; --muted:#9a9a9a; --accent:#ffab5e; --border:#333333; --note-bg:#3a2c1f; }
  }
  body { margin:0; padding:2rem 1rem 4rem; background:var(--bg); color:var(--fg);
         font-family: Georgia, "Nanum Myeongjo", serif; line-height:1.7; }
  main { max-width:700px; margin:0 auto; }
  h2 { margin-bottom:0.25rem; }
  h3 { margin-top:2rem; margin-bottom:0.5rem; font-size:1.15rem; color:var(--muted); }
  .meta { color:var(--muted); font-size:0.9rem; margin-top:0; }
  .meta a { color:var(--accent); }
  .memo-note { margin:0.4rem 0 1.2rem; padding:0.6rem 0.8rem; border-left:3px solid var(--accent);
               background:var(--note-bg); border-radius:0 6px 6px 0; }
  .memo-note p { margin:0; font-size:0.9rem; white-space:pre-wrap; }
  section.vocab { margin-top:3rem; padding-top:1.5rem; border-top:1px solid var(--border); }
  section.vocab h3 { margin-top: 0; }
  section.vocab ul { list-style:none; padding:0; display:flex; flex-wrap:wrap; gap:0.5rem; }
  section.vocab li { background:color-mix(in srgb, var(--accent) 8%, var(--bg)); border-radius:4px;
                      padding:0.3rem 0.6rem; font-size:0.9rem; }
  section.vocab .lemma { font-weight:bold; }
  section.vocab .pos { color:var(--muted); font-size:0.55rem; }
  section.vocab .vocab-meaning { margin-left:0.4rem; padding-left:0.5rem; border-left:1px solid var(--accent);
                                  color:var(--fg); font-size:0.85rem; }
  .vocab-hl { position:relative; cursor:help; text-decoration:underline solid var(--border); text-underline-offset:2px; }
  .vocab-hl::before, .vocab-hl::after { position:absolute; left:50%; bottom:100%; transform:translateX(-50%);
                                         opacity:0; visibility:hidden; pointer-events:none;
                                         transition:opacity 0.12s ease; z-index:60; }
  .vocab-hl::after { content:attr(data-tooltip); margin-bottom:4px; padding:0.35rem 0.65rem; border-radius:6px;
                      background:var(--fg); color:var(--bg); font-family:-apple-system, "Malgun Gothic", sans-serif;
                      font-size:0.8rem; font-weight:normal; line-height:1.4; max-width:220px; width:max-content;
                      white-space:normal; text-align:center; box-shadow:0 2px 8px rgba(0,0,0,0.2); }
  .vocab-hl::before { content:""; margin-bottom:1px; border:5px solid transparent; border-top-color:var(--fg); }
  .vocab-hl:hover::before, .vocab-hl:hover::after { opacity:1; visibility:visible; }
  .back-home { margin:0 0 1.5rem; }
  .back-home a { color:var(--accent); font-size:0.9rem; text-decoration:none; }
  .back-home a:hover { text-decoration:underline; }
</style>
</head>
<body>
  <main>
    <p class="back-home"><a href="/">← 메인 화면으로</a></p>
    <article>
      <h2>${escapeHtml(data.title)}</h2>
      <p class="meta"><a href="${data.url}" target="_blank" rel="noopener">원문 보기</a> · ${escapeHtml(data.published)}</p>
      ${buildBodyHtml(data.blocks, { editable: false, memos })}
    </article>
    <section class="vocab">
      <h3>주요 단어</h3>
      <ul>${buildVocabHtml(data.vocab)}</ul>
    </section>
  </main>
</body>
</html>`;
}

function slugifyFilename(title) {
  const date = new Date().toISOString().slice(0, 10);
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 60);
  return `${date}_${cleaned || "article"}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
