const searchInput = document.getElementById("search");
const listEl = document.getElementById("word-list");
const countEl = document.getElementById("count");
const legendEl = document.getElementById("legend");
const subtitleEl = document.getElementById("subtitle");
const tabsEl = document.getElementById("tabs");
const addTabBtn = document.getElementById("add-tab-btn");

const newTabOverlay = document.getElementById("new-tab-overlay");
const newTabNameInput = document.getElementById("new-tab-name");
const loadJsonBtn = document.getElementById("load-json-btn");
const jsonFileInput = document.getElementById("json-file-input");
const loadedFileNameEl = document.getElementById("loaded-file-name");
const newTabError = document.getElementById("new-tab-error");
const createTabBtn = document.getElementById("create-tab-btn");
const cancelTabBtn = document.getElementById("cancel-tab-btn");

const TAB_INFO = {
  b1: { subtitle: "Goethe-Zertifikat B1 어휘 목록", showLegend: true },
  custom: { subtitle: "기사 공부 모드에서 직접 추가한 단어", showLegend: false },
};

// User-created tabs (name + word list, loaded from a local JSON file) persist
// in localStorage since this app has no backend DB -- see custom tab section
// below for load/save/render.
const CUSTOM_TABS_KEY = "vocabCustomTabs";

let b1Words = [];
let customWords = [];
let customTabs = [];
let currentTab = "b1";
let pendingJsonWords = null;

function findCustomTab(id) {
  return customTabs.find((t) => t.id === id);
}

function activeWords() {
  if (currentTab === "b1") return b1Words;
  if (currentTab === "custom") return customWords;
  const tab = findCustomTab(currentTab);
  return tab ? tab.words : [];
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
    // exact_candidates is precomputed Python-side (wordforms.py) for entries
    // that came from the B1 Wortliste or a study-mode save -- reusing it here
    // instead of re-deriving it in JS keeps the two sides from drifting apart
    // if the extraction rules ever change. A hand-loaded custom-tab JSON (see
    // the "+" tab button) won't have it, so fall back to the bare headword.
    const candidates = w.exact_candidates || (w.headword ? [w.headword] : []);
    w._exactSet = new Set(candidates.map(normalizeForExactMatch));
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

    customTabs = loadCustomTabs();
    customTabs.forEach((t) => indexWords(t.words));
    renderCustomTabButtons();

    render(activeWords());
  } catch (err) {
    listEl.innerHTML = `<li class="placeholder">단어를 불러오지 못했습니다: ${escapeHtml(err.message)}</li>`;
  }
}

function switchTab(tabKey) {
  if (tabKey === currentTab) return;
  currentTab = tabKey;
  tabsEl
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tabKey));

  const info = TAB_INFO[tabKey];
  const custom = findCustomTab(tabKey);
  if (subtitleEl) subtitleEl.textContent = info ? info.subtitle : custom ? custom.name : "";
  if (legendEl) legendEl.style.display = info && info.showLegend ? "" : "none";

  searchInput.value = "";
  render(activeWords());
}

tabsEl.addEventListener("click", (event) => {
  const removeBtn = event.target.closest(".custom-tab-remove");
  if (removeBtn) {
    removeCustomTab(removeBtn.dataset.tabId);
    return;
  }

  const btn = event.target.closest(".tab-btn");
  if (!btn) return;
  if (btn.id === "add-tab-btn") {
    openNewTabModal();
    return;
  }
  switchTab(btn.dataset.tab);
});

// --- Custom tabs (user-created, JSON-loaded, persisted in localStorage) ---

function loadCustomTabs() {
  try {
    const raw = localStorage.getItem(CUSTOM_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomTabs() {
  try {
    localStorage.setItem(CUSTOM_TABS_KEY, JSON.stringify(customTabs));
  } catch (err) {
    alert(`탭을 저장하지 못했습니다: ${err.message}`);
  }
}

function renderCustomTabButtons() {
  tabsEl.querySelectorAll(".custom-tab-btn").forEach((el) => el.remove());
  customTabs.forEach((tab) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn custom-tab-btn" + (currentTab === tab.id ? " active" : "");
    btn.dataset.tab = tab.id;
    btn.innerHTML = `<span>${escapeHtml(tab.name)}</span><span class="custom-tab-remove" data-tab-id="${tab.id}" title="탭 삭제">×</span>`;
    tabsEl.insertBefore(btn, addTabBtn);
  });
}

function removeCustomTab(id) {
  const tab = findCustomTab(id);
  if (!tab) return;
  if (!confirm(`"${tab.name}" 탭을 삭제할까요?`)) return;
  customTabs = customTabs.filter((t) => t.id !== id);
  saveCustomTabs();
  renderCustomTabButtons();
  if (currentTab === id) switchTab("b1");
}

function openNewTabModal() {
  newTabNameInput.value = "";
  jsonFileInput.value = "";
  loadedFileNameEl.textContent = "";
  newTabError.hidden = true;
  pendingJsonWords = null;
  newTabOverlay.hidden = false;
  newTabNameInput.focus();
}

function closeNewTabModal() {
  newTabOverlay.hidden = true;
}

cancelTabBtn.addEventListener("click", closeNewTabModal);

newTabOverlay.addEventListener("click", (event) => {
  if (event.target === newTabOverlay) closeNewTabModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !newTabOverlay.hidden) closeNewTabModal();
});

loadJsonBtn.addEventListener("click", () => jsonFileInput.click());

jsonFileInput.addEventListener("change", () => {
  const file = jsonFileInput.files[0];
  if (!file) return;

  newTabError.hidden = true;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) {
        throw new Error("최상위가 배열(JSON list) 형태여야 합니다.");
      }
      pendingJsonWords = data;
      loadedFileNameEl.textContent = `${file.name} (${data.length.toLocaleString()}개 항목)`;
    } catch (err) {
      pendingJsonWords = null;
      loadedFileNameEl.textContent = "";
      newTabError.textContent = `JSON을 읽지 못했습니다: ${err.message}`;
      newTabError.hidden = false;
    }
  };
  reader.onerror = () => {
    newTabError.textContent = "파일을 읽지 못했습니다.";
    newTabError.hidden = false;
  };
  reader.readAsText(file, "utf-8");
});

createTabBtn.addEventListener("click", () => {
  const name = newTabNameInput.value.trim();
  if (!name) {
    newTabError.textContent = "탭 이름을 입력해주세요.";
    newTabError.hidden = false;
    return;
  }
  if (!pendingJsonWords) {
    newTabError.textContent = "JSON 파일을 먼저 불러와주세요.";
    newTabError.hidden = false;
    return;
  }

  const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tab = { id, name, words: pendingJsonWords };
  indexWords(tab.words);
  customTabs.push(tab);
  saveCustomTabs();
  renderCustomTabButtons();
  closeNewTabModal();
  switchTab(id);
});

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

  // Only the "기사 공부 단어" tab's examples are deletable -- they're the
  // auto-captured first-occurrence sentence from an article (see vocab.py's
  // annotate()), which the player might not like, unlike the B1 Wortliste's
  // official examples.
  const canDeleteExample = currentTab === "custom";
  const examples = (w.examples || [])
    .map((ex) => {
      const deleteBtn = canDeleteExample
        ? `<button type="button" class="delete-example-btn" data-headword="${escapeAttr(w.headword)}" data-pos="${escapeAttr(w.pos)}" title="예문 삭제">×</button>`
        : "";
      return `<li><span class="example-text">${escapeHtml(ex)}</span>${deleteBtn}</li>`;
    })
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

// escapeHtml() alone is safe inside text content but not inside a
// value="..." attribute, since it doesn't escape quotes.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

listEl.addEventListener("click", (event) => {
  const btn = event.target.closest(".delete-example-btn");
  if (btn) deleteCustomExample(btn);
});

async function deleteCustomExample(btn) {
  if (!confirm("이 단어의 예문을 삭제할까요?")) return;
  const { headword, pos } = btn.dataset;
  btn.disabled = true;
  try {
    const params = new URLSearchParams({ headword, pos });
    const res = await fetch(`/api/custom-vocab/example?${params}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "삭제 실패");

    const entry = customWords.find((w) => w.headword === headword && w.pos === pos);
    if (entry) {
      entry.examples = [];
      entry._exampleSearch = "";
    }
    // Removed in place (rather than a full re-render) so an active search
    // query/scroll position isn't disturbed by an unrelated list rebuild.
    const examplesEl = btn.closest(".word-examples");
    if (examplesEl) examplesEl.remove();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}

init();
