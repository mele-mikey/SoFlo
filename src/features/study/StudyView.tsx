import {
  BrainCircuit,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Lightbulb,
  LoaderCircle,
  MessageCircle,
  RotateCcw,
  Send,
  Shuffle,
  SkipForward,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { api } from "../../lib/api";
import type { Flashcard, FlashcardSetDetail } from "../../lib/types";
import { equivalentMath } from "./mathPractice";
import {
  temporaryPracticeFromResponse,
  wantsTemporaryPractice,
  type TemporaryPracticeProblem,
} from "./studyTutor";
import {
  createQuestion,
  createTest,
  isCorrect,
  shuffled,
  type StudyQuestion,
  type TestOptions,
} from "./engine";

interface StudyViewProps {
  sets: FlashcardSetDetail[];
  mode: "flashcards" | "learn" | "test" | "match" | "teachItBack";
  cardIds?: string[];
  aiEnabled: boolean;
  onGenerateTeachQuestion: (
    front: string,
    back: string,
    shownSide: "front" | "back",
    difficulty: "easy" | "hard",
  ) => Promise<string>;
  onGradeTeachAnswer: (
    front: string,
    back: string,
    question: string,
    target: string,
    answer: string,
  ) => Promise<string>;
  onAskStudyTutor: (
    front: string,
    back: string,
    question: string,
    studentWork: string,
    message: string,
    history: string,
    cardsContext: string,
  ) => Promise<string>;
  onGenerateStudyTutorPractice: (
    front: string,
    back: string,
    question: string,
    history: string,
    cardsContext: string,
    request: string,
  ) => Promise<string>;
  onBack: () => void;
  onModeChange: (mode: StudyViewProps["mode"]) => void;
}

type RecordResponse = (
  cardId: string,
  isCorrect: boolean,
  questionType: string,
  answer?: string,
) => void;

type TeachQuestion = { question: string; target: string; hint: string };
type TutorMessage = { id: string; role: "user" | "tutor"; text: string; pending?: boolean };
type TeachGrade = {
  score: number;
  verdict: "strong" | "good" | "developing" | "review";
  feedback: string;
  understood: string[];
  missed: string[];
};
const isMathText = (value: string) =>
  /[=<>√²³π±×÷^_]|\b(?:solve|equation|function|factor|simplify|derivative|integral|graph|slope|interval)\b/i.test(
    value,
  );
const superscriptMap: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁺": "+",
  "⁻": "-",
};
const subscriptMap: Record<string, string> = {
  "₀": "0",
  "₁": "1",
  "₂": "2",
  "₃": "3",
  "₄": "4",
  "₅": "5",
  "₆": "6",
  "₇": "7",
  "₈": "8",
  "₉": "9",
  "₊": "+",
  "₋": "-",
};
const replaceRaised = (
  value: string,
  map: Record<string, string>,
  marker: string,
) =>
  value.replace(
    new RegExp(`[${Object.keys(map).join("")}]+`, "g"),
    (part) =>
      `${marker}{${[...part].map((character) => map[character]).join("")}}`,
  );
function mathLatex(value: string) {
  let latex = value
    .trim()
    .replace(/\\\((.*?)\\\)/gs, "$1")
    .replace(/\\\[(.*?)\\\]/gs, "$1");
  latex = replaceRaised(
    replaceRaised(latex, superscriptMap, "^"),
    subscriptMap,
    "_",
  );
  latex = latex
    .replace(/([A-Za-z])([0-9]+)\b/g, "$1_{$2}")
    .replace(/√\s*\(([^()]+)\)/g, "\\sqrt{$1}")
    .replace(/\bsqrt\s*\(([^()]+)\)/gi, "\\sqrt{$1}");
  latex = latex.replace(
    /(\([^()]+\)|[A-Za-z0-9}]+)\s*\/\s*(\([^()]+\)|[A-Za-z0-9}]+)/g,
    (_match, numerator, denominator) =>
      `\\frac{${String(numerator).replace(/^\(|\)$/g, "")}}{${String(denominator).replace(/^\(|\)$/g, "")}}`,
  );
  return latex
    .replace(/≤/g, "\\le ")
    .replace(/≥/g, "\\ge ")
    .replace(/≠/g, "\\ne ")
    .replace(/≈/g, "\\approx ")
    .replace(/±/g, "\\pm ")
    .replace(/×/g, "\\times ")
    .replace(/÷/g, "\\div ")
    .replace(/(?<!\\)\*/g, "\\cdot ");
}
function MathFormula({
  value,
  display = false,
}: {
  value: string;
  display?: boolean;
}) {
  try {
    return (
      <span
        className={display ? "math-display" : "math-inline"}
        dangerouslySetInnerHTML={{
          __html: katex.renderToString(mathLatex(value), {
            displayMode: display,
            throwOnError: false,
            strict: "ignore",
            trust: false,
          }),
        }}
      />
    );
  } catch {
    return <span>{value}</span>;
  }
}
function MathText({ children }: { children: string }) {
  const mathLike =
    isMathText(children) ||
    /\\(?:frac|sqrt|text|left|right|cdot|times|div|le|ge|ne|approx|pm)\b/.test(
      children,
    );
  const parts: ReactNode[] = [];
  const expression = /\\\[(.*?)\\\]|\\\((.*?)\\\)|\$\$(.*?)\$\$|\$(.*?)\$/gs;
  let offset = 0;
  let match: RegExpExecArray | null;
  const appendPlain = (text: string, key: string) => {
    const tail = text.match(
      /\b([A-Za-z][A-Za-z0-9]*\s*(?:=|≤|≥|<|>|≠|≈|±|×|÷|\^|_)[\s\S]*)$/,
    );
    if (tail?.index !== undefined) {
      if (tail.index)
        parts.push(
          <span key={`${key}-text`}>{text.slice(0, tail.index)}</span>,
        );
      parts.push(<MathFormula key={`${key}-math`} value={tail[1]} />);
    } else if (
      (isMathText(text) ||
        /\\(?:frac|sqrt|text|left|right|cdot|times|div|le|ge|ne|approx|pm)\b/.test(
          text,
        )) &&
      !/[.!?]/.test(text)
    )
      parts.push(<MathFormula key={`${key}-math`} value={text} />);
    else parts.push(<span key={key}>{text}</span>);
  };
  while ((match = expression.exec(children))) {
    appendPlain(children.slice(offset, match.index), `plain-${offset}`);
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    parts.push(
      <MathFormula
        key={`formula-${match.index}`}
        value={value}
        display={Boolean(match[1] ?? match[3])}
      />,
    );
    offset = match.index + match[0].length;
  }
  appendPlain(children.slice(offset), `plain-${offset}`);
  return <span className={mathLike ? "math-study-text" : ""}>{parts}</span>;
}

function parseTeachQuestion(raw: string): TeachQuestion | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const question =
      typeof value.question === "string" ? value.question.trim() : "";
    if (!question) return null;
    return {
      question,
      target: typeof value.target === "string" ? value.target.trim() : "",
      hint: typeof value.hint === "string" ? value.hint.trim() : "",
    };
  } catch {
    return null;
  }
}

function parseTeachGrade(raw: string): TeachGrade | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const score = Math.max(0, Math.min(100, Math.round(Number(value.score))));
    if (!Number.isFinite(score)) return null;
    const list = (key: string) =>
      Array.isArray(value[key])
        ? value[key]
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 3)
        : [];
    const allowed = ["strong", "good", "developing", "review"] as const;
    const verdict = allowed.includes(value.verdict as (typeof allowed)[number])
      ? (value.verdict as (typeof allowed)[number])
      : score >= 85
        ? "strong"
        : score >= 60
          ? "good"
          : score >= 35
            ? "developing"
            : "review";
    return {
      score,
      verdict,
      feedback: typeof value.feedback === "string" ? value.feedback.trim() : "",
      understood: list("understood"),
      missed: list("missed"),
    };
  } catch {
    return null;
  }
}

export function StudyView({
  sets,
  mode,
  cardIds,
  aiEnabled,
  onGenerateTeachQuestion,
  onGradeTeachAnswer,
  onAskStudyTutor,
  onGenerateStudyTutorPractice,
  onBack,
  onModeChange,
}: StudyViewProps) {
  const sessionRef = useRef<Record<string, string>>({});
  const set = sets[0];
  const cards = useMemo(() => {
    const allCards = sets.flatMap((item) => item.cards);
    return cardIds?.length
      ? allCards.filter((card) => cardIds.includes(card.id))
      : allCards;
  }, [cardIds, sets]);
  const [progress, setProgress] = useState(() =>
    sets.flatMap((item) => item.progress),
  );
  const mastery = useMemo(
    () =>
      progress.reduce<Record<string, number>>((summary, item) => {
        summary[item.mastery] = (summary[item.mastery] ?? 0) + 1;
        return summary;
      }, {}),
    [progress],
  );
  const mathSet = useMemo(
    () =>
      set?.studyKind === "math" ||
      (cards.length > 0 &&
        cards.filter((card) => isMathText(`${card.front}\n${card.back}`))
          .length /
          cards.length >=
          0.6),
    [cards, set?.studyKind],
  );
  const availableModes = mathSet
    ? (["flashcards", "learn", "test", "teachItBack"] as const)
    : (["flashcards", "learn", "test", "match", "teachItBack"] as const);

  useEffect(() => setProgress(sets.flatMap((item) => item.progress)), [sets]);
  useEffect(() => {
    let disposed = false;
    sessionRef.current = {};
    void Promise.all(
      sets.map((item) =>
        api
          .startStudySession({ setId: item.id, mode })
          .then((session) => ({ setId: item.id, sessionId: session.id })),
      ),
    )
      .then((sessions) => {
        if (disposed)
          sessions.forEach(
            (session) => void api.completeStudySession(session.sessionId),
          );
        else
          sessionRef.current = Object.fromEntries(
            sessions.map((session) => [session.setId, session.sessionId]),
          );
      })
      .catch(() => {
        sessionRef.current = {};
      });

    return () => {
      disposed = true;
      const sessions = Object.values(sessionRef.current);
      sessionRef.current = {};
      sessions.forEach((sessionId) => void api.completeStudySession(sessionId));
    };
  }, [mode, sets]);

  const record: RecordResponse = (
    cardId,
    isCorrectAnswer,
    questionType,
    answer,
  ) => {
    void api
      .recordCardResponse(cardId, isCorrectAnswer, {
        sessionId:
          sessionRef.current[
            cards.find((card) => card.id === cardId)?.setId ?? ""
          ] ?? undefined,
        mode,
        questionType,
        answer,
      })
      .then((next) => {
        setProgress((current) => {
          const index = current.findIndex((item) => item.cardId === cardId);
          return index < 0
            ? [...current, next]
            : current.map((item) => (item.cardId === cardId ? next : item));
        });
      });
  };

  return (
    <main className="study-view">
      <header className="study-header">
        <button className="back-button" onClick={onBack}>
          <ChevronLeft size={18} />{" "}
          {sets.length === 1 ? set?.title : `${sets.length} selected sets`}
        </button>
        <nav>
          {availableModes.map((item) => (
            <button
              key={item}
              disabled={item === "teachItBack" && !aiEnabled}
              title={
                item === "teachItBack" && !aiEnabled
                  ? "Enable AI in Settings to use Teach It Back"
                  : undefined
              }
              onClick={() => onModeChange(item)}
              className={`${mode === item ? "study-tab active" : "study-tab"}${item === "teachItBack" ? " ai-study-tab" : ""}`}
            >
              {item === "flashcards" ? (
                "Flashcards"
              ) : item === "learn" ? (
                "Learn"
              ) : item === "test" ? (
                "Test"
              ) : item === "match" ? (
                "Match"
              ) : (
                <>
                  <Sparkles size={12} /> Teach It Back
                </>
              )}
            </button>
          ))}
        </nav>
        <span className="study-local">
          {mastery.mastered ?? 0} mastered · {mastery.needsWork ?? 0} need work
        </span>
      </header>
      {mathSet && <MathPractice key={cards.map((card) => `${card.id}:${card.updatedAt}`).join("|")} cards={cards} onRecord={record} onAskTutor={onAskStudyTutor} onGenerateTutorPractice={onGenerateStudyTutorPractice} />}
      {!mathSet && mode === "flashcards" && (
        <Flashcards cards={cards} onRecord={record} />
      )}
      {!mathSet && mode === "learn" && (
        <Learn cards={cards} onRecord={record} />
      )}
      {!mathSet && mode === "test" && (
        <Test setId={set?.id ?? ""} cards={cards} onRecord={record} />
      )}
      {!mathSet && mode === "match" && (
        <Match setId={set?.id ?? ""} cards={cards} onRecord={record} />
      )}
      {!mathSet && mode === "teachItBack" && (
        <TeachItBack
          cards={cards}
          onRecord={record}
          onGenerateQuestion={onGenerateTeachQuestion}
          onGradeAnswer={onGradeTeachAnswer}
          onAskTutor={onAskStudyTutor}
        />
      )}
    </main>
  );
}

function MathPractice({
  cards,
  onRecord,
  onAskTutor,
  onGenerateTutorPractice,
}: {
  cards: Flashcard[];
  onRecord: RecordResponse;
  onAskTutor: StudyViewProps["onAskStudyTutor"];
  onGenerateTutorPractice: StudyViewProps["onGenerateStudyTutorPractice"];
}) {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [checked, setChecked] = useState<boolean | null>(null);
  const [temporaryProblems, setTemporaryProblems] = useState<TemporaryPracticeProblem[]>([]);
  const sessionCards = useMemo(() => [
    ...cards.map((card) => ({ id: card.id, front: card.front, back: card.back, temporary: false })),
    ...temporaryProblems.map((problem, position) => ({ id: `temporary-${position}-${problem.question}`, front: problem.question, back: problem.answer, temporary: true })),
  ], [cards, temporaryProblems]);
  const card = sessionCards[index];
  if (!card)
    return (
      <StudyEmpty text="Add math cards to start a math practice session." />
    );
  const target = card.back.trim();
  const check = () => {
    const correct = equivalentMath(answer, target);
    setChecked(correct);
    if (!card.temporary) onRecord(card.id, correct, "mathPractice", answer);
  };
  const next = () => {
    setIndex((current) => (current + 1) % sessionCards.length);
    setAnswer("");
    setChecked(null);
  };
  const addTemporaryProblems = (problems: TemporaryPracticeProblem[]) => {
    if (!problems.length) return;
    setIndex(cards.length + temporaryProblems.length);
    setTemporaryProblems((current) => [...current, ...problems]);
    setAnswer("");
    setChecked(null);
  };
  return (
    <section className="math-practice">
      <header>
        <div>
          <p className="eyebrow">MATH PRACTICE</p>
          <h1>Math practice</h1>
          <p>
            Use <code>^</code> exponents, <code>/</code> fractions,{" "}
            <code>sqrt()</code>, parentheses, functions, and inequalities.
          </p>
        </div>
        <span>
          {index + 1} / {sessionCards.length}
        </span>
      </header>
      <div className="math-practice-grid">
        <article className="math-problem">
          <small>PROBLEM</small>
          <p><MathText>{card.front}</MathText></p>
          {card.temporary && <p className="math-temporary-label">Temporary tutor practice — it will disappear when you leave this study session.</p>}
          <label>
            Your answer
            <input
              value={answer}
              onChange={(event) => {
                setAnswer(event.target.value);
                setChecked(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") check();
              }}
              placeholder="Example: x^2 / (x + 1)"
              autoFocus
            />
          </label>
          <div className="math-keypad">
            {["x", "y", "^", "/", "(", ")", "sqrt(", "π", "≤", "≥", "∪"].map(
              (key) => (
                <button
                  key={key}
                  onClick={() => setAnswer((current) => current + key)}
                >
                  {key}
                </button>
              ),
            )}
          </div>
          {answer.trim() && <div className="math-answer-preview"><small>Formatted answer</small><MathFormula value={answer} /></div>}
          {checked !== null && (
            <div
              className={
                checked ? "math-result correct" : "math-result incorrect"
              }
            >
              <strong>{checked ? "Correct." : "Not quite."}</strong>
              <span>
                {checked ? (
                  "Your expression is equivalent."
                ) : (
                  "Use the tutor for the next step, then try again."
                )}
              </span>
            </div>
          )}
          <footer>
            <button
              className="button button-primary"
              disabled={!answer.trim()}
              onClick={check}
            >
              Check answer
            </button>
            <button className="button button-soft" onClick={next}>
              Next problem <ChevronRight size={15} />
            </button>
          </footer>
        </article>
        <aside className="math-workspace math-tutor-workspace">
          <StudyTutor
            key={cards.map((item) => `${item.id}:${item.updatedAt}`).join("|")}
            card={card}
            cards={cards}
            question={card.front}
            studentWork={answer}
            onAsk={onAskTutor}
            onGeneratePractice={onGenerateTutorPractice}
            onTemporaryProblems={addTemporaryProblems}
          />
        </aside>
      </div>
    </section>
  );
}

function Flashcards({
  cards,
  onRecord,
}: {
  cards: Flashcard[];
  onRecord: RecordResponse;
}) {
  const [starredOnly, setStarredOnly] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const activeCards = useMemo(() => {
    const selected = starredOnly
      ? cards.filter((card) => card.isStarred)
      : cards;
    return shuffle ? shuffled(selected) : selected;
  }, [cards, shuffle, starredOnly]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [flipNonce, setFlipNonce] = useState(0);

  const flipCard = () => {
    setFlipped((value) => !value);
    setFlipNonce((value) => value + 1);
  };

  useEffect(() => {
    setIndex(0);
    setFlipped(false);
  }, [starredOnly, shuffle]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key === " " &&
        !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)
      ) {
        event.preventDefault();
        flipCard();
      }
      if (event.key === "ArrowRight")
        setIndex((value) => Math.min(value + 1, activeCards.length - 1));
      if (event.key === "ArrowLeft")
        setIndex((value) => Math.max(value - 1, 0));
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [activeCards.length]);

  const card = activeCards[index];
  const advance = (known?: boolean) => {
    if (!card) return;
    if (known !== undefined)
      onRecord(card.id, known, "flashcard", known ? "know" : "stillLearning");
    setFlipped(false);
    setIndex((value) => Math.min(value + 1, activeCards.length - 1));
  };

  return (
    <section className="flashcard-study">
      <div className="study-controls">
        <label>
          <input
            type="checkbox"
            checked={starredOnly}
            onChange={(event) => setStarredOnly(event.target.checked)}
          />
          <Star size={14} /> Starred only
        </label>
        <button
          className={
            shuffle ? "toggle-study-control active" : "toggle-study-control"
          }
          onClick={() => setShuffle((value) => !value)}
        >
          <Shuffle size={15} /> Shuffle
        </button>
      </div>
      {card ? (
        <>
          <p className="study-progress">
            {index + 1} / {activeCards.length}
          </p>
          <button
            key={flipNonce}
            className={`flashcard ${flipped ? "flipped" : ""}${flipNonce ? " flip-animate" : ""}`}
            onClick={flipCard}
          >
            <span className="flashcard-side">
              <small>{flipped ? "Definition" : "Term"}</small>
              <strong>
                <MathText>{flipped ? card.back : card.front}</MathText>
              </strong>
              <em>Click or press Space to flip</em>
            </span>
          </button>
          <div className="study-footer">
            <button
              className="round-button"
              disabled={index === 0}
              onClick={() => {
                setFlipped(false);
                setIndex((value) => value - 1);
              }}
              aria-label="Previous card"
            >
              <ChevronLeft size={21} />
            </button>
            {flipped ? (
              <>
                <button
                  className="button response-button learning"
                  onClick={() => advance(false)}
                >
                  <X size={17} /> I don’t know it
                </button>
                <button
                  className="button response-button know"
                  onClick={() => advance(true)}
                >
                  <Check size={17} /> I know it
                </button>
              </>
            ) : (
              <span className="study-hint">Flip the card to self-check</span>
            )}
            <button
              className="round-button"
              disabled={index === activeCards.length - 1}
              onClick={() => advance()}
              aria-label="Next card"
            >
              <ChevronRight size={21} />
            </button>
          </div>
        </>
      ) : (
        <div className="flashcard-filter-empty">
          <Star size={22} />
          <h2>
            {starredOnly ? "No starred cards yet." : "No cards in this set."}
          </h2>
          <p>
            {starredOnly
              ? "Uncheck Starred only to keep studying every card."
              : "Add cards to this set before starting a session."}
          </p>
          {starredOnly && (
            <button
              className="button button-soft button-small"
              onClick={() => setStarredOnly(false)}
            >
              Show all cards
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function TeachItBack({
  cards,
  onRecord,
  onGenerateQuestion,
  onGradeAnswer,
  onAskTutor,
}: {
  cards: Flashcard[];
  onRecord: RecordResponse;
  onGenerateQuestion: StudyViewProps["onGenerateTeachQuestion"];
  onGradeAnswer: StudyViewProps["onGradeTeachAnswer"];
  onAskTutor: StudyViewProps["onAskStudyTutor"];
}) {
  const [queue, setQueue] = useState(() => shuffled(cards));
  const [index, setIndex] = useState(0);
  const [question, setQuestion] = useState<TeachQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [grade, setGrade] = useState<TeachGrade | null>(null);
  const [loadingQuestion, setLoadingQuestion] = useState(false);
  const [grading, setGrading] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [error, setError] = useState("");
  const [correctCount, setCorrectCount] = useState(0);
  const [difficulty, setDifficulty] = useState<"easy" | "hard">("hard");
  const [difficultyOpen, setDifficultyOpen] = useState(false);
  const [questionNonce, setQuestionNonce] = useState(0);
  const generateQuestionRef = useRef(onGenerateQuestion);
  useEffect(() => {
    generateQuestionRef.current = onGenerateQuestion;
  }, [onGenerateQuestion]);
  const card = queue[index];
  const shownSide: "front" | "back" = index % 2 === 0 ? "front" : "back";
  const mathMode = isMathText(`${card?.front ?? ""}\n${card?.back ?? ""}`);

  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    setQuestion(null);
    setAnswer("");
    setGrade(null);
    setShowHint(false);
    setError("");
    setLoadingQuestion(true);
    void generateQuestionRef
      .current(card.front, card.back, shownSide, difficulty)
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseTeachQuestion(raw);
        if (parsed) setQuestion(parsed);
        else
          setQuestion({
            question:
              shownSide === "front"
                ? difficulty === "easy"
                  ? `Describe ${card.front} in your own words. What does it mean?`
                  : `Explain ${card.front} in your own words, including an important detail or connection.`
                : difficulty === "easy"
                  ? "What idea does this description represent? Give its general meaning."
                  : "What idea does this description represent, and what important detail helps explain it?",
            target: shownSide === "front" ? card.back : card.front,
            hint:
              shownSide === "front"
                ? card.back.split(/\s+/).slice(0, 4).join(" ")
                : card.front,
          });
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "SoFlo could not prepare this question.",
          );
          setQuestion({
            question:
              shownSide === "front"
                ? difficulty === "easy"
                  ? `Describe ${card.front} in your own words. What does it mean?`
                  : `Explain ${card.front} and one important detail connected to it.`
                : difficulty === "easy"
                  ? "What idea does this description represent?"
                  : "What idea does this description represent, and what important detail belongs with it?",
            target: shownSide === "front" ? card.back : card.front,
            hint: "",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingQuestion(false);
      });
    return () => {
      cancelled = true;
    };
  }, [card, difficulty, shownSide, questionNonce]);

  if (!cards.length)
    return <StudyEmpty text="Add cards before using Teach It Back." />;
  if (!card)
    return (
      <section className="teach-back-study teach-back-complete">
        <span className="teach-back-orb">
          <BrainCircuit size={29} />
        </span>
        <p className="eyebrow">TEACH IT BACK</p>
        <h1>You explained the whole set.</h1>
        <p>
          {correctCount} of {queue.length} explanations showed solid
          understanding. Every response has been added to your mastery history.
        </p>
        <button
          className="button button-primary ai-action"
          onClick={() => {
            setQueue(shuffled(cards));
            setIndex(0);
            setCorrectCount(0);
          }}
        >
          <RotateCcw size={16} /> Teach it again
        </button>
      </section>
    );

  const submit = async () => {
    if (!question || !answer.trim() || grading || grade) return;
    setGrading(true);
    setError("");
    try {
      const parsed = parseTeachGrade(
        await onGradeAnswer(
          card.front,
          card.back,
          question.question,
          question.target,
          answer.trim(),
        ),
      );
      if (!parsed)
        throw new Error("SoFlo could not read this teach-back review.");
      setGrade(parsed);
      const correct = parsed.score >= 60;
      if (correct) setCorrectCount((value) => value + 1);
      onRecord(card.id, correct, "teachItBack", answer.trim());
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "SoFlo could not grade this explanation.",
      );
      setGrade({
        score: 0,
        verdict: "review",
        feedback:
          "The local model could not grade this response, so SoFlo kept your session moving. Review the card once more when you are ready.",
        understood: [],
        missed: [],
      });
      onRecord(card.id, false, "teachItBack", answer.trim());
    } finally {
      setGrading(false);
    }
  };
  const next = () => setIndex((value) => value + 1);
  const skip = () => {
    if (loadingQuestion || grading || grade) return;
    onRecord(card.id, false, "teachItBack", "[skipped]");
    next();
  };

  return (
    <section className="teach-back-study">
      <div className="teach-back-heading">
        <div>
          <p className="eyebrow">AI STUDY GAME</p>
          <h1>{mathMode ? "Work It Out." : "Teach It Back."}</h1>
          <p>
            {mathMode
              ? "Solve the problem step by step. SoFlo checks the method and your final answer."
              : "Explain the idea naturally. SoFlo checks your understanding, then always moves you forward."}
          </p>
        </div>
        <span>
          {index + 1} / {queue.length}
        </span>
      </div>
      <article className="teach-back-card">
        <div className="teach-back-clue">
          <small>
            {mathMode
              ? "CONCEPT / REFERENCE"
              : shownSide === "front"
                ? "TERM / PROMPT"
                : "DEFINITION / CONTEXT"}
          </small>
          <strong>
            <MathText>
              {shownSide === "front" ? card.front : card.back}
            </MathText>
          </strong>
        </div>
        <div className="teach-back-question">
          <div className="teach-back-question-bar">
            <small>
              {mathMode
                ? "SOLVE IT STEP BY STEP"
                : "DESCRIBE IT IN YOUR OWN WORDS"}
            </small>
            <button
              type="button"
              onClick={() => setDifficultyOpen((open) => !open)}
            >
              Too Hard? Change Difficulty.
            </button>
            {difficultyOpen && (
              <div
                className="teach-back-difficulty"
                role="dialog"
                aria-label="Teach It Back difficulty"
              >
                <span>QUESTION DIFFICULTY</span>
                <div>
                  <button
                    className={difficulty === "easy" ? "active" : ""}
                    onClick={() => {
                      setDifficulty("easy");
                      setDifficultyOpen(false);
                    }}
                  >
                    Easy
                  </button>
                  <button
                    className={difficulty === "hard" ? "active" : ""}
                    onClick={() => {
                      setDifficulty("hard");
                      setDifficultyOpen(false);
                    }}
                  >
                    Hard
                  </button>
                </div>
                <p>
                  {difficulty === "easy"
                    ? "Focus on the general definition."
                    : "Include a connection, detail, or extra step."}
                </p>
              </div>
            )}
          </div>
          {loadingQuestion ? (
            <div className="teach-back-loading">
              <LoaderCircle size={19} /> Building a {difficulty} question from
              both sides of this card…
            </div>
          ) : (
            <h2>
              <MathText>{question?.question ?? ""}</MathText>
            </h2>
          )}
        </div>
        {mathMode && !loadingQuestion && !grade && (
          <button
            className="teach-back-hint"
            onClick={() => setQuestionNonce((value) => value + 1)}
          >
            <Sparkles size={14} /> New solvable version
          </button>
        )}
        {question?.hint && !grade && (
          <button
            className="teach-back-hint"
            onClick={() => setShowHint((value) => !value)}
          >
            <Lightbulb size={14} />{" "}
            {showHint ? question.hint : "Need a small hint?"}
          </button>
        )}
        <textarea
          value={answer}
          disabled={loadingQuestion || Boolean(grade)}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
              void submit();
          }}
          rows={6}
          placeholder={
            mathMode
              ? "Show your steps and final answer..."
              : "Explain what this means as if you were teaching it to someone else…"
          }
        />
        {error && <p className="teach-back-error">{error}</p>}
        {!grade && (
          <div className="teach-back-actions">
            <button
              className="button button-primary ai-action teach-back-submit"
              disabled={loadingQuestion || grading || !answer.trim()}
              onClick={() => void submit()}
            >
              {grading ? (
                <>
                  <LoaderCircle className="teach-back-spin" size={16} />{" "}
                  Reviewing your explanation…
                </>
              ) : (
                <>
                  <Sparkles size={16} /> Check my explanation
                </>
              )}
            </button>
            <button
              className="button teach-back-skip"
              disabled={loadingQuestion || grading}
              onClick={skip}
            >
              Skip <SkipForward size={15} />
            </button>
          </div>
        )}
        {grade && (
          <div
            className={`teach-back-grade ${grade.score >= 60 ? "passed" : "review"}`}
          >
            <div>
              <span>{grade.score}</span>
              <div>
                <small>{grade.verdict}</small>
                <strong>
                  {grade.score >= 60
                    ? "You understand this."
                    : "Give this one another look."}
                </strong>
              </div>
            </div>
            <p>{grade.feedback}</p>
            {grade.understood.length > 0 && (
              <section>
                <strong>What you understood</strong>
                <ul>
                  {grade.understood.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            )}
            {grade.missed.length > 0 && (
              <section>
                <strong>Worth reviewing</strong>
                <ul>
                  {grade.missed.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            )}
            <button className="button button-primary" onClick={next}>
              {index === queue.length - 1 ? "Finish set" : "Next question"}{" "}
              <ChevronRight size={15} />
            </button>
          </div>
        )}
        <StudyTutor
          key={cards.map((item) => `${item.id}:${item.updatedAt}`).join("|")}
          card={card}
          cards={cards}
          question={question?.question ?? ""}
          studentWork={answer}
          onAsk={onAskTutor}
        />
      </article>
    </section>
  );
}

function compactTutorCardContext(cards: Pick<Flashcard, "front" | "back">[]) {
  return cards.slice(0, 24).map((item, index) => `CARD ${index + 1}\nFront: ${item.front.trim()}\nBack: ${item.back.trim()}`).join("\n\n").slice(0, 8_000);
}

function StudyTutor({ card, cards, question, studentWork, onAsk, onGeneratePractice, onTemporaryProblems }: { card: Pick<Flashcard, "id" | "front" | "back">; cards: Flashcard[]; question: string; studentWork: string; onAsk: StudyViewProps["onAskStudyTutor"]; onGeneratePractice?: StudyViewProps["onGenerateStudyTutorPractice"]; onTemporaryProblems?: (problems: TemporaryPracticeProblem[]) => void }) {
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [typing, setTyping] = useState(false);
  const cardsContext = useMemo(() => compactTutorCardContext(cards), [cards]);
  const send = async () => {
    const message = draft.trim();
    if (!message || loading) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nextHistory = [...messages, { id, role: "user" as const, text: message }].slice(-12);
    const history = JSON.stringify(nextHistory.map(({ role, text }) => ({ role, text })));
    setDraft("");
    setTyping(false);
    setMessages((current) => [...current.slice(-11), { id, role: "user", text: message, pending: true }]);
    setLoading(true);
    try {
      let reply: string;
      if (onGeneratePractice && onTemporaryProblems && wantsTemporaryPractice(message)) {
        const problems = temporaryPracticeFromResponse(await onGeneratePractice(card.front, card.back, question, history, cardsContext, message));
        if (!problems.length) throw new Error("The tutor could not make temporary practice questions from this card.");
        onTemporaryProblems(problems);
        reply = `Added ${problems.length} temporary practice ${problems.length === 1 ? "question" : "questions"}. They are not saved to your flashcards, and the first one is ready now.`;
      } else {
        reply = await onAsk(card.front, card.back, question, studentWork, message, history, cardsContext);
      }
      setMessages((current) => [...current.map((item) => item.id === id ? { ...item, pending: false } : item), { id: `${id}-reply`, role: "tutor" as const, text: reply || "Try writing the next step you think belongs here." }].slice(-12));
    } catch (error) {
      setMessages((current) => [...current.map((item) => item.id === id ? { ...item, pending: false } : item), { id: `${id}-error`, role: "tutor" as const, text: error instanceof Error ? error.message : "The tutor could not respond right now." }].slice(-12));
    } finally { setLoading(false); }
  };
  return <section className="study-tutor">
    <header><span><MessageCircle size={15} /> General AI tutor</span><small>{loading ? "Thinking…" : typing ? "Typing…" : "Hints only — never reveals the answer."}</small></header>
    <div className="study-tutor-messages" aria-live="polite">
      {messages.length === 0 && <p className="tutor-intro">Ask for a hint, show your work, or ask for more temporary practice questions.</p>}
      {messages.map((message) => <p key={message.id} className={`${message.role}${message.pending ? " user-pending" : ""}`}><MathText>{message.text}</MathText></p>)}
      {loading && <p className="tutor-loading"><span className="tutor-typing-dots" aria-hidden="true"><i /><i /><i /></span>Thinking through the next step…</p>}
    </div>
    <div><textarea value={draft} rows={2} disabled={loading} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} onChange={(event) => { setDraft(event.target.value); setTyping(Boolean(event.target.value.trim())) }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void send() }} placeholder="Ask for a hint or more practice…" /><button className="button button-soft button-small ai-action" disabled={loading || !draft.trim()} onClick={() => void send()}><Send size={14} /> Ask</button></div>
  </section>;
}

function Learn({
  cards,
  onRecord,
}: {
  cards: Flashcard[];
  onRecord: RecordResponse;
}) {
  const [queue, setQueue] = useState(() => shuffled(cards));
  const [index, setIndex] = useState(0);
  const [question, setQuestion] = useState<StudyQuestion | null>(() => {
    const firstCard = queue[0] ?? cards[0];
    return firstCard
      ? createQuestion(firstCard, cards, "multipleChoice")
      : null;
  });
  const [answer, setAnswer] = useState("");
  const [graded, setGraded] = useState<boolean | null>(null);
  const [correctCount, setCorrectCount] = useState(0);

  useEffect(() => {
    const next = queue[index];
    if (!next) {
      setQuestion(null);
      return;
    }
    const types: StudyQuestion["type"][] = ["multipleChoice", "trueFalse"];
    setQuestion(
      createQuestion(
        next,
        cards,
        types[index % types.length] ?? "multipleChoice",
      ),
    );
    setAnswer("");
    setGraded(null);
  }, [cards, index, queue]);

  if (!cards.length || !question)
    return <StudyEmpty text="Add cards to learn from this set." />;
  const response = question.type === "trueFalse" ? answer === "true" : answer;
  const submit = () => {
    const correct = isCorrect(question, response);
    setGraded(correct);
    onRecord(question.cardId, correct, question.type, String(response));
    if (correct) setCorrectCount((value) => value + 1);
    else {
      const missedCard = cards.find((card) => card.id === question.cardId);
      if (missedCard) setQueue((previous) => [...previous, missedCard]);
    }
  };
  const next = () => setIndex((value) => Math.min(value + 1, queue.length - 1));

  return (
    <section className="learn-study">
      <div className="learn-topline">
        <div>
          <p className="eyebrow">LEARN</p>
          <h1>Build durable recall.</h1>
        </div>
        <span>{correctCount} correct</span>
      </div>
      <div className="learn-progress">
        <i
          style={{
            width: `${Math.min(100, (correctCount / Math.max(cards.length, 1)) * 100)}%`,
          }}
        />
      </div>
      <article className="learn-card">
        <small>
          {question.type === "multipleChoice"
            ? "Choose the best answer"
            : "True or false?"}
        </small>
        <h2>
          {question.type === "trueFalse" ? (
            <>
              <MathText>{question.prompt}</MathText>
              <span className="question-definition">
                <MathText>{question.shownDefinition}</MathText>
              </span>
            </>
          ) : (
            <MathText>{question.prompt}</MathText>
          )}
        </h2>
        {question.type === "multipleChoice" && (
          <div className="answer-grid">
            {question.choices.map((choice) => (
              <button
                disabled={graded !== null}
                className={answer === choice ? "selected" : ""}
                onClick={() => setAnswer(choice)}
                key={choice}
              >
                <MathText>{choice}</MathText>
              </button>
            ))}
          </div>
        )}
        {question.type === "trueFalse" && (
          <div className="true-false-actions">
            <button
              disabled={graded !== null}
              className={answer === "true" ? "selected" : ""}
              onClick={() => setAnswer("true")}
            >
              True
            </button>
            <button
              disabled={graded !== null}
              className={answer === "false" ? "selected" : ""}
              onClick={() => setAnswer("false")}
            >
              False
            </button>
          </div>
        )}
        {graded === null && (
          <button
            className="button button-primary learn-check-button"
            disabled={!answer}
            onClick={submit}
          >
            Check answer
          </button>
        )}
        {graded !== null && (
          <div
            className={
              graded ? "grade-message correct" : "grade-message incorrect"
            }
          >
            <strong>{graded ? "Correct" : "Not quite"}</strong>
            <span>
              {question.type === "trueFalse" ? (
                `The pairing is ${question.answer ? "true" : "false"}.`
              ) : (
                <>
                  Answer: <MathText>{String(question.answer)}</MathText>
                </>
              )}
            </span>
            <button
              className="button button-primary button-small"
              onClick={next}
            >
              Continue <ChevronRight size={15} />
            </button>
          </div>
        )}
      </article>
    </section>
  );
}

function Test({
  setId,
  cards,
  onRecord,
}: {
  setId: string;
  cards: Flashcard[];
  onRecord: RecordResponse;
}) {
  const [options, setOptions] = useState<TestOptions>({
    count: Math.min(10, cards.length),
    multipleChoice: true,
    written: true,
    trueFalse: true,
    starredOnly: false,
    definitionFirst: false,
    shuffle: true,
  });
  const [questions, setQuestions] = useState<StudyQuestion[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [attentionQuestionId, setAttentionQuestionId] = useState<string | null>(
    null,
  );
  const questionRefs = useRef<Record<string, HTMLElement | null>>({});
  const begin = () => {
    setQuestions(createTest(cards, options));
    setAnswers({});
    setSubmitted(false);
    setAttentionQuestionId(null);
  };

  if (!questions)
    return (
      <section className="test-config">
        <p className="eyebrow">TEST</p>
        <h1>Make it yours.</h1>
        <p>
          Choose a balance of question types, then take a focused local test.
        </p>
        <label className="range-row">
          Questions{" "}
          <input
            type="range"
            min="1"
            max={Math.max(1, cards.length)}
            value={options.count}
            onChange={(event) =>
              setOptions({ ...options, count: Number(event.target.value) })
            }
          />
          <strong>{options.count}</strong>
        </label>
        <div className="check-grid">
          {(
            [
              { key: "multipleChoice", label: "Multiple choice" },
              { key: "written", label: "Written response" },
              { key: "trueFalse", label: "True / false" },
              { key: "definitionFirst", label: "Definition first" },
              { key: "starredOnly", label: "Starred cards only" },
              { key: "shuffle", label: "Shuffle questions" },
            ] as { key: keyof TestOptions; label: string }[]
          ).map((item) => (
            <label key={item.key}>
              <input
                type="checkbox"
                checked={Boolean(options[item.key])}
                onChange={(event) =>
                  setOptions({ ...options, [item.key]: event.target.checked })
                }
              />
              {item.label}
            </label>
          ))}
        </div>
        <button
          className="button button-primary"
          disabled={!cards.length}
          onClick={begin}
        >
          Start test
        </button>
      </section>
    );

  const isAnswered = (question: StudyQuestion) => {
    const answer = answers[question.id];
    return (
      typeof answer === "boolean" ||
      (typeof answer === "string" && answer.trim().length > 0)
    );
  };
  const unanswered = questions.filter((question) => !isAnswered(question));
  const score = questions.filter((question) =>
    isCorrect(question, answers[question.id] ?? ""),
  ).length;
  const submit = () => {
    if (submitted) return;
    const firstMissing = unanswered[0];
    if (firstMissing) {
      setAttentionQuestionId(firstMissing.id);
      window.requestAnimationFrame(() =>
        questionRefs.current[firstMissing.id]?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        }),
      );
      window.setTimeout(
        () =>
          setAttentionQuestionId((current) =>
            current === firstMissing.id ? null : current,
          ),
        1500,
      );
      return;
    }
    setSubmitted(true);
    questions.forEach((question) => {
      const answer = answers[question.id] ?? "";
      onRecord(
        question.cardId,
        isCorrect(question, answer),
        question.type,
        String(answer),
      );
    });
    void api.saveTestAttempt({
      setId,
      score: score / questions.length,
      correctCount: score,
      questionCount: questions.length,
      answersJson: JSON.stringify(answers),
    });
  };

  return (
    <section className="test-run">
      <div className="test-run-heading">
        <div>
          <p className="eyebrow">TEST</p>
          <h1>
            {submitted
              ? `${Math.round((score / questions.length) * 100)}%`
              : `${questions.length - unanswered.length} of ${questions.length}`}
          </h1>
        </div>
        {submitted && (
          <button
            className="button button-soft"
            onClick={() => setQuestions(null)}
          >
            <RotateCcw size={16} /> Retake test
          </button>
        )}
      </div>
      {submitted && (
        <p className="test-score-summary">
          {score} correct · {questions.length - score} to review
        </p>
      )}
      <div className="test-question-list">
        {questions.map((question, index) => (
          <TestQuestion
            key={question.id}
            question={question}
            index={index}
            answer={answers[question.id]}
            onAnswer={(value) =>
              !submitted &&
              setAnswers((current) => ({ ...current, [question.id]: value }))
            }
            reviewed={submitted}
            attention={attentionQuestionId === question.id}
            questionRef={(node) => {
              questionRefs.current[question.id] = node;
            }}
          />
        ))}
      </div>
      {!submitted && (
        <footer className="test-submit-footer">
          <span>
            {unanswered.length
              ? `${unanswered.length} question${unanswered.length === 1 ? "" : "s"} remaining`
              : "All questions answered"}
          </span>
          <button className="button button-primary" onClick={submit}>
            Submit test
          </button>
        </footer>
      )}
    </section>
  );
}

function TestQuestion({
  question,
  index,
  answer,
  onAnswer,
  reviewed,
  attention,
  questionRef,
}: {
  question: StudyQuestion;
  index: number;
  answer: string | boolean | undefined;
  onAnswer: (value: string | boolean) => void;
  reviewed: boolean;
  attention: boolean;
  questionRef: (node: HTMLElement | null) => void;
}) {
  const correct = reviewed ? isCorrect(question, answer ?? "") : null;
  return (
    <article
      ref={questionRef}
      className={`test-question ${attention ? "needs-attention" : ""} ${correct === true ? "correct" : correct === false ? "incorrect" : ""}`}
    >
      <span>{index + 1}</span>
      <div>
        <p>
          {question.type === "trueFalse" ? (
            <>
              <MathText>{question.prompt}</MathText>
              <br />
              <em>
                <MathText>{question.shownDefinition}</MathText>
              </em>
            </>
          ) : (
            <MathText>{question.prompt}</MathText>
          )}
        </p>
        {question.type === "multipleChoice" && (
          <div className="answer-grid compact">
            {question.choices.map((choice) => (
              <button
                disabled={reviewed}
                className={answer === choice ? "selected" : ""}
                onClick={() => onAnswer(choice)}
                key={choice}
              >
                <MathText>{choice}</MathText>
              </button>
            ))}
          </div>
        )}
        {question.type === "written" && (
          <input
            disabled={reviewed}
            value={typeof answer === "string" ? answer : ""}
            onChange={(event) => onAnswer(event.target.value)}
            placeholder="Your answer"
          />
        )}
        {question.type === "trueFalse" && (
          <div className="true-false-actions compact">
            <button
              disabled={reviewed}
              className={answer === true ? "selected" : ""}
              onClick={() => onAnswer(true)}
            >
              True
            </button>
            <button
              disabled={reviewed}
              className={answer === false ? "selected" : ""}
              onClick={() => onAnswer(false)}
            >
              False
            </button>
          </div>
        )}
        {reviewed && (
          <small className="review-answer">
            {correct ? (
              "Correct"
            ) : question.type === "trueFalse" ? (
              `Correct answer: ${question.answer ? "True" : "False"}`
            ) : (
              <>
                Correct answer: <MathText>{String(question.answer)}</MathText>
              </>
            )}
          </small>
        )}
      </div>
    </article>
  );
}

function formatMatchTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Match({
  setId,
  cards,
  onRecord,
}: {
  setId: string;
  cards: Flashcard[];
  onRecord: RecordResponse;
}) {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [pairs, setPairs] = useState(() => cards.slice(0, 6));
  const [termTiles, setTermTiles] = useState(() => shuffled(cards.slice(0, 6)));
  const [definitionTiles, setDefinitionTiles] = useState(() =>
    shuffled(cards.slice(0, 6)),
  );
  const [selected, setSelected] = useState<{
    id: string;
    side: "front" | "back";
  } | null>(null);
  const [matched, setMatched] = useState<string[]>([]);
  const [mistake, setMistake] = useState<
    Array<{ id: string; side: "front" | "back" }>
  >([]);
  const [time, setTime] = useState(0);
  const [bestTime, setBestTime] = useState<number | null>(null);
  const complete = pairs.length > 0 && matched.length === pairs.length;

  useEffect(() => {
    let current = true;
    void api.getMatchBestTime(setId).then((best) => {
      if (current) setBestTime(best);
    });
    return () => {
      current = false;
    };
  }, [setId]);
  useEffect(() => {
    if (complete) return;
    const timer = window.setInterval(
      () => setTime(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => window.clearInterval(timer);
  }, [complete, startedAt]);
  useEffect(() => {
    if (!complete || time < 1) return;
    void api.saveMatchTime(setId, time).then(setBestTime);
  }, [complete, setId, time]);

  const choose = (id: string, side: "front" | "back") => {
    if (matched.includes(id) || mistake.length || complete) return;
    if (!selected) {
      setSelected({ id, side });
      return;
    }
    if (selected.id === id && selected.side !== side) {
      onRecord(id, true, "match", "matched");
      if (matched.length === pairs.length - 1)
        setTime(Math.max(1, Math.floor((Date.now() - startedAt) / 1000)));
      setMatched((previous) => [...previous, id]);
      setSelected(null);
    } else {
      onRecord(selected.id, false, "match", "mismatch");
      onRecord(id, false, "match", "mismatch");
      setMistake([
        { id: selected.id, side: selected.side },
        { id, side },
      ]);
      window.setTimeout(() => {
        setMistake([]);
        setSelected(null);
      }, 450);
    }
  };
  const restart = () => {
    const nextPairs = cards.slice(0, 6);
    setPairs(nextPairs);
    setTermTiles(shuffled(nextPairs));
    setDefinitionTiles(shuffled(nextPairs));
    setMatched([]);
    setSelected(null);
    setMistake([]);
    setTime(0);
    setStartedAt(Date.now());
  };

  if (!pairs.length) return <StudyEmpty text="Add cards to play Match." />;
  return (
    <section className="match-study">
      <div className="match-header">
        <div>
          <p className="eyebrow">MATCH</p>
          <h1>{complete ? "Complete." : "Make the pairs."}</h1>
        </div>
        <div className="match-times">
          <span>
            <Clock3 size={16} /> {formatMatchTime(time)}
          </span>
          <small>
            Best {bestTime === null ? "—" : formatMatchTime(bestTime)}
          </small>
        </div>
      </div>
      <p>
        Match each term with its definition.{" "}
        {complete &&
          (bestTime === time
            ? "New best time—nice work."
            : "Nice work—try again to beat your best time.")}
      </p>
      <div className="match-grid">
        {(["front", "back"] as const).map((side) => (
          <div className="match-column" key={side}>
            {(side === "front" ? termTiles : definitionTiles).map((card) => (
              <button
                key={`${side}-${card.id}`}
                onClick={() => choose(card.id, side)}
                className={`match-tile ${matched.includes(card.id) ? "matched" : ""} ${selected?.id === card.id && selected.side === side ? "selected" : ""} ${mistake.some((tile) => tile.id === card.id && tile.side === side) ? "mistake" : ""}`}
              >
                <MathText>{side === "front" ? card.front : card.back}</MathText>
              </button>
            ))}
          </div>
        ))}
      </div>
      {complete && (
        <button className="button button-primary" onClick={restart}>
          <RotateCcw size={16} /> Play again
        </button>
      )}
    </section>
  );
}

function StudyEmpty({ text }: { text: string }) {
  return (
    <section className="study-empty">
      <Sparkles size={25} />
      <h1>Not quite ready.</h1>
      <p>{text}</p>
    </section>
  );
}
