const cardEl = document.getElementById("quiz-card");
const scoreEl = document.getElementById("score");

const BLANK = "______";

let questions = [];
let current = null;
let currentIndex = -1;
let answered = false;
let hintUsed = false;
let score = { correct: 0, total: 0 };

async function init() {
  try {
    const res = await fetch("/static/quiz_index.json");
    questions = await res.json();
    nextQuestion();
  } catch (err) {
    cardEl.innerHTML = `<p class="placeholder">문제를 불러오지 못했습니다: ${escapeHtml(err.message)}</p>`;
  }
}

function nextQuestion() {
  if (questions.length === 0) return;
  let idx = currentIndex;
  if (questions.length > 1) {
    while (idx === currentIndex) {
      idx = Math.floor(Math.random() * questions.length);
    }
  } else {
    idx = 0;
  }
  currentIndex = idx;
  current = questions[idx];
  answered = false;
  hintUsed = false;
  render();
}

// Each blank in the sentence is rendered as one underscore per letter of its
// word (not a fixed-width placeholder), so the hint button can later reveal
// just the first letter of the first blank in place -- rather than dumping
// it into the answer input, which is what showed the answer prematurely for
// multi-blank (split separable-verb) questions before.
function buildBlankSpan(word, index) {
  const underscores = "_".repeat(word.length);
  return `<span class="blank" id="blank-${index}">${escapeHtml(underscores)}</span>`;
}

function renderSentence(sentence, answerWords) {
  const parts = sentence.split(BLANK);
  let html = escapeHtml(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    html += buildBlankSpan(answerWords[i - 1] || "", i - 1);
    html += escapeHtml(parts[i]);
  }
  return html;
}

function render() {
  updateScore();

  // The example sentences have no Korean translation, so without the
  // headword's meaning there'd be no way to tell which B1 word is wanted --
  // show it up front, separately from the letter-reveal hint button below.
  const meaningHtml = current.meaning_ko
    ? `<p class="quiz-meaning">뜻: <strong>${escapeHtml(current.meaning_ko)}</strong></p>`
    : "";
  const answerWords = current.answer.split(" ");

  cardEl.innerHTML = `
    ${meaningHtml}
    <p class="quiz-sentence">${renderSentence(current.sentence, answerWords)}</p>
    <form id="quiz-form" autocomplete="off">
      <input
        id="quiz-input"
        type="text"
        placeholder="정답을 입력하세요"
        autocomplete="off"
      />
      <div class="quiz-actions">
        <button type="button" id="hint-btn" class="secondary-btn">힌트</button>
        <button type="submit" id="submit-btn">확인</button>
      </div>
    </form>
    <div id="quiz-feedback"></div>
  `;

  const input = document.getElementById("quiz-input");
  const form = document.getElementById("quiz-form");
  const hintBtn = document.getElementById("hint-btn");

  input.focus();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitAnswer(input.value);
  });

  hintBtn.addEventListener("click", () => {
    if (hintUsed || !current.answer) return;
    hintUsed = true;
    hintBtn.disabled = true;
    const firstWord = answerWords[0] || "";
    const firstLetter = current.case_sensitive ? firstWord.charAt(0) : firstWord.charAt(0).toLowerCase();
    const firstBlank = document.getElementById("blank-0");
    if (firstBlank && firstWord) {
      firstBlank.textContent = firstLetter + firstBlank.textContent.slice(1);
    }
    input.focus();
  });
}

// Accepts the standard ASCII-keyboard spellings for umlauts/eszett (ae/oe/ue/ss)
// as equivalent to ä/ö/ü/ß, in either direction -- normalizing both sides to
// the digraph form before comparing means it doesn't matter which one the
// player actually types.
function normalizeUmlauts(str) {
  return str
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss");
}

function submitAnswer(rawValue) {
  if (answered) return;
  answered = true;
  score.total += 1;

  const given = normalizeUmlauts(rawValue.trim());
  const answer = normalizeUmlauts(current.answer);
  // Noun answers keep German's always-capitalized spelling rule; other
  // answers only ever look capitalized because they start the sentence, so
  // that capital isn't part of the word itself -- compare loosely for those.
  const correct = current.case_sensitive
    ? given === answer
    : given.toLowerCase() === answer.toLowerCase();
  if (correct) score.correct += 1;
  updateScore();

  const input = document.getElementById("quiz-input");
  const hintBtn = document.getElementById("hint-btn");
  const submitBtn = document.getElementById("submit-btn");
  input.disabled = true;
  hintBtn.disabled = true;
  submitBtn.disabled = true;

  const feedback = document.getElementById("quiz-feedback");
  feedback.innerHTML = `
    <p class="quiz-result ${correct ? "correct" : "incorrect"}">
      ${correct ? "정답입니다!" : "틀렸습니다."}
      ${correct ? "" : `정답: <strong>${escapeHtml(current.answer)}</strong>`}
    </p>
    <p class="quiz-answer-context">${escapeHtml(current.headword)}</p>
    <button type="button" id="next-btn">다음 문제 →</button>
  `;

  const nextBtn = document.getElementById("next-btn");
  nextBtn.focus();
  nextBtn.addEventListener("click", nextQuestion);
}

function updateScore() {
  scoreEl.textContent = `${score.correct} / ${score.total} 정답`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

init();
