const addWordBtn = document.getElementById("add-word-btn");
const wordListEl = document.getElementById("word-list");

// Bare-word sets (from the two read-only dictionaries) used only for the
// "already exists" notice -- never used to block a save, since the user may
// deliberately want a second entry (e.g. a different nuance/example).
const b1BareSet = new Set();
const customBareSet = new Set();

// In-memory mirror of custom_ext_vocab.json, kept in sync with every
// add/update/delete so the "수정" button can look an entry up by id without
// having to round-trip it back out of the escaped, already-rendered DOM.
let currentWords = [];

let tempCounter = 0;

// Same normalization vocab.js uses for search: accepts ASCII digraph
// spellings (ae/oe/ue/ss) as equivalent to ä/ö/ü/ß.
function normalizeUmlauts(str) {
  return str.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

// Reduces a headword to a bare, comparable form: drops parenthetical notes,
// "→ ..." cross-references and a trailing ", -e"-style plural/regional tail,
// then strips a leading der/die/das article. Good enough for a duplicate
// *hint*, not meant to be as exhaustive as vocab.js's search-candidate logic.
function bareWord(headword) {
  let s = (headword || "").replace(/\([^)]*\)/g, " ");
  s = s.split("→")[0].split(",")[0].trim();
  s = s.replace(/^(der|die|das)\s+/i, "");
  return normalizeUmlauts(s.toLowerCase());
}

async function init() {
  wordListEl.innerHTML = '<li class="placeholder">불러오는 중...</li>';
  try {
    const [mineRes, b1Res, customRes] = await Promise.all([
      fetch("/static/custom_ext_vocab.json"),
      fetch("/static/goethe_b1_wortliste.json"),
      fetch("/static/custom_vocab.json"),
    ]);
    const mine = mineRes.ok ? await mineRes.json() : [];
    const b1 = b1Res.ok ? await b1Res.json() : [];
    const custom = customRes.ok ? await customRes.json() : [];

    b1.forEach((w) => b1BareSet.add(bareWord(w.headword)));
    custom.forEach((w) => customBareSet.add(bareWord(w.headword)));

    currentWords = mine;
    render(currentWords);
  } catch (err) {
    wordListEl.innerHTML = `<li class="placeholder">단어를 불러오지 못했습니다: ${escapeHtml(err.message)}</li>`;
  }
}

function render(mine) {
  if (mine.length === 0) {
    wordListEl.innerHTML =
      '<li class="placeholder" id="empty-placeholder">아직 추가한 단어가 없습니다. "단어 추가하기"를 눌러 시작해보세요.</li>';
    return;
  }
  // Newest-added shows first.
  wordListEl.innerHTML = mine.slice().reverse().map(renderSavedItem).join("");
}

function renderSavedItem(w) {
  let forms = "";
  const formRows = [
    ["3인칭 단수", w.present_3sg],
    ["과거형", w.preterite],
    ["과거분사", w.perfect],
  ].filter(([, value]) => value);
  if (formRows.length) {
    const rows = formRows
      .map(([label, value]) => `<span class="form-label">${label}</span><span class="form-value">${escapeHtml(value)}</span>`)
      .join("");
    forms = `<div class="forms">${rows}</div>`;
  }

  const posHtml = w.pos ? `<span class="word-pos-tag">${escapeHtml(w.pos)}</span>` : "";
  const meaningKo = w.meaning_ko ? `<span class="meaning-ko">${escapeHtml(w.meaning_ko)}</span>` : "";
  const examples = (w.examples || []).map((ex) => `<li>${escapeHtml(ex)}</li>`).join("");
  const examplesHtml = examples ? `<ul class="word-examples">${examples}</ul>` : "";

  return `
    <li class="word-item" data-id="${w.id}">
      <div class="word-head">
        <div class="headword-row">
          <span class="headword">${escapeHtml(w.headword)}</span>
          ${posHtml}
        </div>
        ${meaningKo}
        ${forms}
        <div class="word-actions">
          <button type="button" class="edit-word-btn" data-id="${w.id}">수정</button>
          <button type="button" class="delete-word-btn" data-id="${w.id}">삭제</button>
        </div>
      </div>
      ${examplesHtml}
    </li>
  `;
}

const POS_OPTIONS = ["명사", "동사", "형용사", "기타"];

// Shared markup for both a blank "add" block (idAttr = data-temp-id) and a
// prefilled "edit" block for an existing entry (idAttr = data-id) -- the
// inflection boxes are only shown when pos is already "동사" (verb), same
// rule the .edit-pos change listener applies when the user switches it.
function editBlockMarkup({ idAttr, headword, pos, meaning, examples, present3sg, preterite, perfect }) {
  const formsHidden = pos === "동사" ? "" : "hidden";
  const posOptions = POS_OPTIONS.map(
    (p) => `<option value="${p}"${p === pos ? " selected" : ""}>${p}</option>`
  ).join("");

  return `
    <li class="word-item editing" ${idAttr}>
      <input type="text" class="edit-headword" placeholder="단어 (예: die Abbildung, -en / gehen / schnell)" autocomplete="off" value="${escapeAttr(headword)}" />
      <div class="edit-row">
        <select class="edit-pos">${posOptions}</select>
        <span class="dup-notice" hidden></span>
      </div>
      <textarea class="edit-meaning" rows="2" placeholder="뜻 (한국어)">${escapeHtml(meaning)}</textarea>
      <div class="edit-forms" ${formsHidden}>
        <input type="text" class="edit-present3sg" placeholder="3인칭 단수 현재형 (예: geht)" autocomplete="off" value="${escapeAttr(present3sg)}" />
        <input type="text" class="edit-preterite" placeholder="과거형 (예: ging)" autocomplete="off" value="${escapeAttr(preterite)}" />
        <input type="text" class="edit-perfect" placeholder="과거분사 (예: ist gegangen)" autocomplete="off" value="${escapeAttr(perfect)}" />
      </div>
      <textarea class="edit-examples" rows="2" placeholder="예문 (한 줄에 하나씩)">${escapeHtml(examples)}</textarea>
      <span class="save-error" hidden></span>
      <div class="edit-actions">
        <button type="button" class="save-word-btn">저장</button>
        <button type="button" class="cancel-word-btn secondary-btn">취소</button>
      </div>
    </li>
  `;
}

function renderEditBlock(tempId) {
  return editBlockMarkup({
    idAttr: `data-temp-id="${tempId}"`,
    headword: "",
    pos: "명사",
    meaning: "",
    examples: "",
    present3sg: "",
    preterite: "",
    perfect: "",
  });
}

function renderEditFormFor(entry) {
  return editBlockMarkup({
    idAttr: `data-id="${entry.id}"`,
    headword: entry.headword || "",
    pos: entry.pos || "명사",
    meaning: entry.meaning_ko || "",
    examples: (entry.examples || []).join("\n"),
    present3sg: entry.present_3sg || "",
    preterite: entry.preterite || "",
    perfect: entry.perfect || "",
  });
}

addWordBtn.addEventListener("click", () => {
  const placeholder = document.getElementById("empty-placeholder");
  if (placeholder) placeholder.remove();

  const tempId = `new-${tempCounter++}`;
  wordListEl.insertAdjacentHTML("afterbegin", renderEditBlock(tempId));
  const li = wordListEl.querySelector(`li[data-temp-id="${tempId}"]`);
  li.querySelector(".edit-headword").focus();
});

wordListEl.addEventListener("change", (event) => {
  if (!event.target.classList.contains("edit-pos")) return;
  const li = event.target.closest("li");
  li.querySelector(".edit-forms").hidden = event.target.value !== "동사";
});

wordListEl.addEventListener("input", (event) => {
  if (!event.target.classList.contains("edit-headword")) return;
  checkDuplicate(event.target.closest("li"));
});

function checkDuplicate(li) {
  const input = li.querySelector(".edit-headword");
  const notice = li.querySelector(".dup-notice");
  const bare = bareWord(input.value);
  if (!bare) {
    notice.hidden = true;
    return;
  }
  if (b1BareSet.has(bare)) {
    notice.textContent = "⚠ 이미 B1 단어장에 있는 단어입니다.";
    notice.hidden = false;
  } else if (customBareSet.has(bare)) {
    notice.textContent = "⚠ 이미 학습 단어장(공부 모드)에 있는 단어입니다.";
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}

function showEmptyPlaceholderIfNeeded() {
  if (!wordListEl.querySelector("li")) {
    wordListEl.innerHTML =
      '<li class="placeholder" id="empty-placeholder">아직 추가한 단어가 없습니다. "단어 추가하기"를 눌러 시작해보세요.</li>';
  }
}

wordListEl.addEventListener("click", (event) => {
  if (event.target.classList.contains("cancel-word-btn")) {
    const li = event.target.closest("li");
    const id = li.dataset.id;
    if (id) {
      // Editing an existing entry -- restore its saved (read-only) view
      // instead of deleting it.
      const entry = currentWords.find((w) => w.id === id);
      if (entry) li.outerHTML = renderSavedItem(entry);
    } else {
      // A brand-new, unsaved draft block -- just discard it.
      li.remove();
      showEmptyPlaceholderIfNeeded();
    }
    return;
  }
  if (event.target.classList.contains("save-word-btn")) {
    saveWord(event.target.closest("li"));
    return;
  }
  if (event.target.classList.contains("edit-word-btn")) {
    const id = event.target.dataset.id;
    const entry = currentWords.find((w) => w.id === id);
    if (!entry) return;
    event.target.closest("li").outerHTML = renderEditFormFor(entry);
    const newLi = wordListEl.querySelector(`li[data-id="${id}"]`);
    if (newLi) newLi.querySelector(".edit-headword").focus();
    return;
  }
  if (event.target.classList.contains("delete-word-btn")) {
    deleteWord(event.target);
  }
});

async function saveWord(li) {
  // A real id means this block is editing an existing entry (PUT); no id
  // (only a temp id) means it's a brand-new draft (POST).
  const id = li.dataset.id;

  const headword = li.querySelector(".edit-headword").value.trim();
  const pos = li.querySelector(".edit-pos").value;
  const meaning_ko = li.querySelector(".edit-meaning").value.trim();
  const examples = li
    .querySelector(".edit-examples")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const errorEl = li.querySelector(".save-error");
  errorEl.hidden = true;

  if (!headword || !meaning_ko) {
    errorEl.textContent = "단어와 뜻은 필수입니다.";
    errorEl.hidden = false;
    return;
  }

  const payload = { headword, pos, meaning_ko, examples };
  if (pos === "동사") {
    payload.present_3sg = li.querySelector(".edit-present3sg").value.trim();
    payload.preterite = li.querySelector(".edit-preterite").value.trim();
    payload.perfect = li.querySelector(".edit-perfect").value.trim();
  }

  const saveBtn = li.querySelector(".save-word-btn");
  saveBtn.disabled = true;
  try {
    const res = await fetch(id ? `/api/my-vocab/${id}` : "/api/my-vocab", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "저장 실패");

    if (id) {
      const idx = currentWords.findIndex((w) => w.id === id);
      if (idx !== -1) currentWords[idx] = data;
    } else {
      currentWords.push(data);
    }
    li.outerHTML = renderSavedItem(data);
  } catch (err) {
    errorEl.textContent = `오류: ${err.message}`;
    errorEl.hidden = false;
    saveBtn.disabled = false;
  }
}

async function deleteWord(btn) {
  if (!confirm("이 단어를 삭제할까요?")) return;
  const id = btn.dataset.id;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/my-vocab/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("삭제 실패");
    currentWords = currentWords.filter((w) => w.id !== id);
    btn.closest("li").remove();
    showEmptyPlaceholderIfNeeded();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// escapeHtml() alone is safe inside text content but not inside a
// value="..." attribute, since it doesn't escape quotes.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

init();
