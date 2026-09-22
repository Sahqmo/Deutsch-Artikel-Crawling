const searchInput = document.getElementById("search");
const listEl = document.getElementById("word-list");
const countEl = document.getElementById("count");
const legendEl = document.getElementById("legend");
const subtitleEl = document.getElementById("subtitle");
const tabButtons = document.querySelectorAll(".tab-btn");

const TAB_INFO = {
  b1: { subtitle: "Goethe-Zertifikat B1 어휘 목록", showLegend: true },
  custom: { subtitle: "기사 공부 모드에서 직접 추가한 단어", showLegend: false },
};

let b1Words = [];
let customWords = [];
let currentTab = "b1";

function activeWords() {
  return currentTab === "b1" ? b1Words : customWords;
}

// Accepts the standard ASCII-keyboard spellings for umlauts/eszett (ae/oe/ue/ss)
// as equivalent to ä/ö/ü/ß -- normalizing both the indexed text and the query
// to the digraph form means a search matches regardless of which form the
// dictionary entry or the typed query happens to use.
function normalizeUmlauts(str) {
  return str.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

function indexWords(list) {
  list.forEach((w) => {
    w._headwordSearch = normalizeUmlauts(
      [w.headword, w.present_3sg, w.preterite, w.perfect]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
    );
    w._exampleSearch = normalizeUmlauts((w.examples || []).join(" ").toLowerCase());
    w._meaningSearch = normalizeUmlauts((w.meaning_ko || "").toLowerCase());
    w._exactSet = new Set(extractExactCandidates(w.headword).map(normalizeForExactMatch));
  });
}

async function init() {
  listEl.innerHTML = '<li class="placeholder">불러오는 중...</li>';
  try {
    const [b1Res, customRes] = await Promise.all([
      fetch("/static/goethe_b1_wortliste.json"),
      fetch("/static/custom_vocab.json"),
    ]);
    b1Words = await b1Res.json();
    customWords = customRes.ok ? await customRes.json() : [];
    indexWords(b1Words);
    indexWords(customWords);
    render(activeWords());
  } catch (err) {
    listEl.innerHTML = `<li class="placeholder">단어를 불러오지 못했습니다: ${escapeHtml(err.message)}</li>`;
  }
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === currentTab) return;
    currentTab = btn.dataset.tab;
    tabButtons.forEach((b) => b.classList.toggle("active", b === btn));

    const info = TAB_INFO[currentTab];
    if (subtitleEl && info) subtitleEl.textContent = info.subtitle;
    if (legendEl && info) legendEl.style.display = info.showLegend ? "" : "none";

    searchInput.value = "";
    render(activeWords());
  });
});

// Reduce a headword to its bare, comparable word form(s) so a search term can
// be checked for an *exact* match. For nouns this strips the leading article
// (der/die/das, incl. "der*die"/"die/das" combos) and the plural-marker /
// regional-note tail; gender-pair nouns ("der Lehrer, die Lehrerin, -nen")
// yield one candidate per noun. Non-noun headwords (verbs, adjectives,
// prefixes) fall back to their comma-separated segments.
function extractExactCandidates(headword) {
  let s = headword.replace(/\([^)]*\)/g, " "); // drop parenthetical notes
  s = s.split("→")[0].trim(); // drop "→ ..." cross-reference tail

  const candidates = [];
  const articleRe = /\b(?:der|die|das)\s+([A-ZÄÖÜ][^\s,;()/]*)/g;
  let m;
  while ((m = articleRe.exec(s))) {
    candidates.push(m[1]);
  }

  if (candidates.length === 0) {
    s.split(",").forEach((seg) => {
      seg = seg.trim();
      if (seg) candidates.push(seg);
    });
  }

  // Alternate spellings joined directly by "/" (e.g. "Glace/Glacé",
  // "Nord-/Ostsee") stop the article regex above at the "/", which is what
  // keeps it from gluing onto an adjacent "der/die/das ..." clause (e.g.
  // "Hausfrau/der Hausmann"). Add both sides here, unless one of them is
  // itself an article (which means the "/" was separating two clauses,
  // not two spellings of the same word).
  const slashPairRe = /([^\s,;()/]+)\/([^\s,;()/]+)/g;
  while ((m = slashPairRe.exec(s))) {
    const left = m[1];
    const right = m[2];
    if (!/^(der|die|das)$/i.test(left) && !/^(der|die|das)$/i.test(right)) {
      candidates.push(left, right);
    }
  }

  const expanded = [];
  candidates.forEach((c) => {
    c.split("/").forEach((part) => {
      part = part.trim();
      if (part) expanded.push(part);
    });
  });
  return expanded;
}

function normalizeForExactMatch(str) {
  return normalizeUmlauts(str.trim().toLowerCase().replace(/^-+|-+$/g, ""));
}

searchInput.addEventListener("input", () => {
  const raw = searchInput.value.trim();
  const list = activeWords();
  if (!raw) {
    render(list);
    return;
  }

  const query = normalizeUmlauts(raw.toLowerCase());
  const exactQuery = normalizeForExactMatch(raw);

  const wordMatches = [];
  const exampleMatches = [];
  list.forEach((w) => {
    if (w._headwordSearch.includes(query) || w._meaningSearch.includes(query)) {
      wordMatches.push(w);
    } else if (w._exampleSearch.includes(query)) {
      exampleMatches.push(w);
    }
  });

  // Exact word matches float to the top of the word-comparison group.
  const exact = wordMatches.filter((w) => w._exactSet.has(exactQuery));
  const partial = wordMatches.filter((w) => !w._exactSet.has(exactQuery));

  renderGrouped([...exact, ...partial], exampleMatches, exactQuery);
});

function render(list) {
  countEl.textContent = `${list.length.toLocaleString()}개 단어`;

  if (list.length === 0) {
    const msg =
      currentTab === "custom"
        ? "아직 추가한 단어가 없습니다. 기사 페이지의 공부 모드에서 단어 뜻을 입력하고 저장해보세요."
        : "검색 결과가 없습니다.";
    listEl.innerHTML = `<li class="placeholder">${msg}</li>`;
    return;
  }

  listEl.innerHTML = list.map((w) => renderItem(w)).join("");
}

function renderGrouped(wordMatches, exampleMatches, exactQuery) {
  const total = wordMatches.length + exampleMatches.length;
  countEl.textContent = `${total.toLocaleString()}개 단어`;

  if (total === 0) {
    listEl.innerHTML = '<li class="placeholder">검색 결과가 없습니다.</li>';
    return;
  }

  let html = "";
  if (wordMatches.length) {
    html += `<li class="result-heading">단어 비교<span class="result-count">${wordMatches.length}</span></li>`;
    html += wordMatches.map((w) => renderItem(w, w._exactSet.has(exactQuery))).join("");
  }
  if (exampleMatches.length) {
    html += `<li class="result-heading">예문 비교<span class="result-count">${exampleMatches.length}</span></li>`;
    html += exampleMatches.map((w) => renderItem(w)).join("");
  }
  listEl.innerHTML = html;
}

// Separable verbs (e.g. "abschreiben" -> "schreibt ab") show the split
// particle at the end of present_3sg. If it matches the start of the
// infinitive, mark the split with a small dot: "ab·schreiben".
function detectSeparablePrefix(headword, present3sg) {
  if (!present3sg) return null;

  const words = present3sg.trim().split(/\s+/).filter((w) => w.toLowerCase() !== "sich");
  if (words.length < 2) return null;

  const particle = words[words.length - 1];
  const leadMatch = headword.match(/^((?:\([^)]*\)\s+)?(?:sich\s+)?)(.*)$/s);
  const before = leadMatch[1] || "";
  const core = leadMatch[2];

  if (particle.length > 0 && particle.length < core.length && core.toLowerCase().startsWith(particle.toLowerCase())) {
    return { before, prefix: core.slice(0, particle.length), base: core.slice(particle.length) };
  }
  return null;
}

function renderHeadword(w) {
  const sep = detectSeparablePrefix(w.headword, w.present_3sg);
  if (!sep) {
    return escapeHtml(w.headword);
  }
  return `${escapeHtml(sep.before)}${escapeHtml(sep.prefix)}<span class="sep-mark">·</span>${escapeHtml(sep.base)}`;
}

function renderItem(w, isExact) {
  const cls = w.level === 1 ? "word-item nebeneintrag" : "word-item";

  let forms = "";
  if (w.present_3sg) {
    const rows = [
      ["3인칭 단수", w.present_3sg],
      ["과거형", w.preterite],
      ["과거분사", w.perfect],
    ]
      .map(([label, value]) => `<span class="form-label">${label}</span><span class="form-value">${escapeHtml(value)}</span>`)
      .join("");
    forms = `<div class="forms">${rows}</div>`;
  }

  let related = "";
  if (w.level === 1 && w.parent) {
    related = `<span class="related">→ ${escapeHtml(w.parent)}</span>`;
  }

  const meaningKo = w.meaning_ko
    ? `<span class="meaning-ko">${escapeHtml(w.meaning_ko)}</span>`
    : "";

  const examples = (w.examples || [])
    .map((ex) => `<li>${escapeHtml(ex)}</li>`)
    .join("");
  const examplesHtml = examples ? `<ul class="word-examples">${examples}</ul>` : "";

  return `
    <li class="${cls}">
      <div class="word-head">
        <div class="headword-row">
          <span class="headword">${renderHeadword(w)}</span>
          ${isExact ? '<span class="exact-badge">일치</span>' : ""}
        </div>
        ${meaningKo}
        ${forms}
        ${related}
      </div>
      ${examplesHtml}
    </li>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

init();
