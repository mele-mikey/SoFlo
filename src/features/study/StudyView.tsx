import { Check, ChevronLeft, ChevronRight, Clock3, RotateCcw, Shuffle, Sparkles, Star, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import type { Flashcard, FlashcardSetDetail } from '../../lib/types'
import { createQuestion, createTest, isCorrect, shuffled, type StudyQuestion, type TestOptions } from './engine'

interface StudyViewProps {
  set: FlashcardSetDetail
  mode: 'flashcards' | 'learn' | 'test' | 'match'
  onBack: () => void
  onModeChange: (mode: StudyViewProps['mode']) => void
}

export function StudyView({ set, mode, onBack, onModeChange }: StudyViewProps) {
  return <main className="study-view"><header className="study-header"><button className="back-button" onClick={onBack}><ChevronLeft size={18} /> {set.title}</button><nav>{(['flashcards', 'learn', 'test', 'match'] as const).map((item) => <button key={item} onClick={() => onModeChange(item)} className={mode === item ? 'study-tab active' : 'study-tab'}>{item === 'flashcards' ? 'Flashcards' : item === 'learn' ? 'Learn' : item === 'test' ? 'Test' : 'Match'}</button>)}</nav><span className="study-local">Local study</span></header>
    {mode === 'flashcards' && <Flashcards cards={set.cards} />}
    {mode === 'learn' && <Learn cards={set.cards} />}
    {mode === 'test' && <Test setId={set.id} cards={set.cards} />}
    {mode === 'match' && <Match cards={set.cards} />}
  </main>
}

function Flashcards({ cards }: { cards: Flashcard[] }) {
  const [starredOnly, setStarredOnly] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const activeCards = useMemo(() => { const selected = starredOnly ? cards.filter((card) => card.isStarred) : cards; return shuffle ? shuffled(selected) : selected }, [cards, shuffle, starredOnly])
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  useEffect(() => { setIndex(0); setFlipped(false) }, [starredOnly, shuffle])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if (event.key === ' ' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) { event.preventDefault(); setFlipped((value) => !value) } if (event.key === 'ArrowRight') setIndex((value) => Math.min(value + 1, activeCards.length - 1)); if (event.key === 'ArrowLeft') setIndex((value) => Math.max(value - 1, 0)) }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard)
  }, [activeCards.length])
  const card = activeCards[index]
  if (!card) return <StudyEmpty text={starredOnly ? 'No starred cards in this set.' : 'Add cards before starting a study session.'} />
  const advance = (known?: boolean) => { if (known !== undefined) void api.recordCardResponse(card.id, known); setFlipped(false); setIndex((value) => Math.min(value + 1, activeCards.length - 1)) }
  return <section className="flashcard-study"><div className="study-controls"><label><input type="checkbox" checked={starredOnly} onChange={(event) => setStarredOnly(event.target.checked)} /><Star size={14} /> Starred only</label><button className={shuffle ? 'toggle-study-control active' : 'toggle-study-control'} onClick={() => setShuffle((value) => !value)}><Shuffle size={15} /> Shuffle</button></div><p className="study-progress">{index + 1} / {activeCards.length}</p><button className={`flashcard ${flipped ? 'flipped' : ''}`} onClick={() => setFlipped((value) => !value)}><span className="flashcard-side"><small>{flipped ? 'Definition' : 'Term'}</small><strong>{flipped ? card.back : card.front}</strong><em>Click or press Space to flip</em></span></button><div className="study-footer"><button className="round-button" disabled={index === 0} onClick={() => { setFlipped(false); setIndex((value) => value - 1) }} aria-label="Previous card"><ChevronLeft size={21} /></button>{flipped ? <><button className="button response-button learning" onClick={() => advance(false)}><X size={17} /> Still learning</button><button className="button response-button know" onClick={() => advance(true)}><Check size={17} /> Know it</button></> : <span className="study-hint">Flip the card to self-check</span>}<button className="round-button" disabled={index === activeCards.length - 1} onClick={() => advance()} aria-label="Next card"><ChevronRight size={21} /></button></div></section>
}

function Learn({ cards }: { cards: Flashcard[] }) {
  const [queue, setQueue] = useState(() => shuffled(cards))
  const [index, setIndex] = useState(0)
  const [question, setQuestion] = useState<StudyQuestion | null>(() => {
    const firstCard = queue[0] ?? cards[0]
    return firstCard ? createQuestion(firstCard, cards, 'multipleChoice') : null
  })
  const [answer, setAnswer] = useState('')
  const [graded, setGraded] = useState<boolean | null>(null)
  const [correctCount, setCorrectCount] = useState(0)
  useEffect(() => { const next = queue[index]; if (next) { const types: StudyQuestion['type'][] = ['multipleChoice', 'written', 'trueFalse']; setQuestion(createQuestion(next, cards, types[index % types.length] ?? 'multipleChoice')); setAnswer(''); setGraded(null) } else { setQuestion(null) } }, [cards, index, queue])
  if (!cards.length || !question) return <StudyEmpty text="Add cards to learn from this set." />
  const response = question.type === 'trueFalse' ? answer === 'true' : answer
  const submit = (override?: boolean) => { const correct = override ?? isCorrect(question, response); setGraded(correct); if (correct) { setCorrectCount((value) => value + 1); void api.recordCardResponse(question.cardId, true) } else { void api.recordCardResponse(question.cardId, false); const missedCard = cards.find((card) => card.id === question.cardId); if (missedCard) setQueue((previous) => [...previous, missedCard]) } }
  const next = () => setIndex((value) => Math.min(value + 1, queue.length - 1))
  return <section className="learn-study"><div className="learn-topline"><div><p className="eyebrow">LEARN</p><h1>Build durable recall.</h1></div><span>{correctCount} correct</span></div><div className="learn-progress"><i style={{ width: `${Math.min(100, (correctCount / Math.max(cards.length, 1)) * 100)}%` }} /></div><article className="learn-card"><small>{question.type === 'multipleChoice' ? 'Choose the best answer' : question.type === 'written' ? 'Type the answer' : 'True or false?'}</small><h2>{question.type === 'trueFalse' ? <>{question.prompt}<span className="question-definition">{question.shownDefinition}</span></> : question.prompt}</h2>{question.type === 'multipleChoice' && <div className="answer-grid">{question.choices.map((choice) => <button disabled={graded !== null} className={answer === choice ? 'selected' : ''} onClick={() => setAnswer(choice)} key={choice}>{choice}</button>)}</div>}{question.type === 'written' && <input autoFocus disabled={graded !== null} value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && answer.trim() && graded === null) submit() }} placeholder="Type your answer" />}{question.type === 'trueFalse' && <div className="true-false-actions"><button disabled={graded !== null} className={answer === 'true' ? 'selected' : ''} onClick={() => setAnswer('true')}>True</button><button disabled={graded !== null} className={answer === 'false' ? 'selected' : ''} onClick={() => setAnswer('false')}>False</button></div>}{graded === null && <button className="button button-primary learn-check-button" disabled={question.type === 'written' ? !answer.trim() : !answer} onClick={() => submit()}>Check answer</button>}{graded !== null && <div className={graded ? 'grade-message correct' : 'grade-message incorrect'}><strong>{graded ? 'Correct' : 'Not quite'}</strong><span>{question.type === 'trueFalse' ? `The pairing is ${question.answer ? 'true' : 'false'}.` : `Answer: ${question.answer}`}</span>{!graded && question.type === 'written' && <button className="text-button" onClick={() => submit(true)}>Mark correct anyway</button>}<button className="button button-primary button-small" onClick={next}>Continue <ChevronRight size={15} /></button></div>}</article></section>
}

function Test({ setId, cards }: { setId: string; cards: Flashcard[] }) {
  const [options, setOptions] = useState<TestOptions>({ count: Math.min(10, cards.length), multipleChoice: true, written: true, trueFalse: true, starredOnly: false, definitionFirst: false, shuffle: true })
  const [questions, setQuestions] = useState<StudyQuestion[] | null>(null)
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({})
  const [submitted, setSubmitted] = useState(false)
  const begin = () => { setQuestions(createTest(cards, options)); setAnswers({}); setSubmitted(false) }
  if (!questions) return <section className="test-config"><p className="eyebrow">TEST</p><h1>Make it yours.</h1><p>Choose a balance of question types, then take a focused local test.</p><label className="range-row">Questions <input type="range" min="1" max={Math.max(1, cards.length)} value={options.count} onChange={(event) => setOptions({ ...options, count: Number(event.target.value) })} /><strong>{options.count}</strong></label><div className="check-grid">{([{ key: 'multipleChoice', label: 'Multiple choice' }, { key: 'written', label: 'Written response' }, { key: 'trueFalse', label: 'True / false' }, { key: 'definitionFirst', label: 'Definition first' }, { key: 'starredOnly', label: 'Starred cards only' }, { key: 'shuffle', label: 'Shuffle questions' }] as { key: keyof TestOptions; label: string }[]).map((item) => <label key={item.key}><input type="checkbox" checked={Boolean(options[item.key])} onChange={(event) => setOptions({ ...options, [item.key]: event.target.checked })} />{item.label}</label>)}</div><button className="button button-primary" disabled={!cards.length} onClick={begin}>Start test</button></section>
  const score = questions.filter((question) => isCorrect(question, answers[question.id] ?? '')).length
  const submit = () => { setSubmitted(true); void api.saveTestAttempt({ setId, score: score / questions.length, correctCount: score, questionCount: questions.length, answersJson: JSON.stringify(answers) }) }
  return <section className="test-run"><div className="test-run-heading"><div><p className="eyebrow">TEST</p><h1>{submitted ? `${Math.round((score / questions.length) * 100)}%` : `${Object.keys(answers).length} of ${questions.length}`}</h1></div>{submitted ? <button className="button button-soft" onClick={() => setQuestions(null)}><RotateCcw size={16} /> Retake test</button> : <button className="button button-primary" onClick={submit}>Submit test</button>}</div>{submitted && <p className="test-score-summary">{score} correct · {questions.length - score} to review</p>}<div className="test-question-list">{questions.map((question, index) => <TestQuestion key={question.id} question={question} index={index} answer={answers[question.id]} onAnswer={(value) => !submitted && setAnswers({ ...answers, [question.id]: value })} reviewed={submitted} />)}</div></section>
}

function TestQuestion({ question, index, answer, onAnswer, reviewed }: { question: StudyQuestion; index: number; answer: string | boolean | undefined; onAnswer: (value: string | boolean) => void; reviewed: boolean }) {
  const correct = reviewed ? isCorrect(question, answer ?? '') : null
  return <article className={`test-question ${correct === true ? 'correct' : correct === false ? 'incorrect' : ''}`}><span>{index + 1}</span><div><p>{question.type === 'trueFalse' ? <>{question.prompt}<br /><em>{question.shownDefinition}</em></> : question.prompt}</p>{question.type === 'multipleChoice' && <div className="answer-grid compact">{question.choices.map((choice) => <button className={answer === choice ? 'selected' : ''} onClick={() => onAnswer(choice)} key={choice}>{choice}</button>)}</div>}{question.type === 'written' && <input value={typeof answer === 'string' ? answer : ''} onChange={(event) => onAnswer(event.target.value)} placeholder="Your answer" />}{question.type === 'trueFalse' && <div className="true-false-actions compact"><button className={answer === true ? 'selected' : ''} onClick={() => onAnswer(true)}>True</button><button className={answer === false ? 'selected' : ''} onClick={() => onAnswer(false)}>False</button></div>}{reviewed && <small className="review-answer">{correct ? 'Correct' : `Correct answer: ${question.type === 'trueFalse' ? (question.answer ? 'True' : 'False') : question.answer}`}</small>}</div></article>
}

function Match({ cards }: { cards: Flashcard[] }) {
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [pairs, setPairs] = useState(() => cards.slice(0, 6))
  const [termTiles, setTermTiles] = useState(() => shuffled(cards.slice(0, 6)))
  const [definitionTiles, setDefinitionTiles] = useState(() => shuffled(cards.slice(0, 6)))
  const [selected, setSelected] = useState<{ id: string; side: 'front' | 'back' } | null>(null)
  const [matched, setMatched] = useState<string[]>([])
  const [mistake, setMistake] = useState<string[]>([])
  const [time, setTime] = useState(0)
  useEffect(() => { const timer = window.setInterval(() => setTime(Math.floor((Date.now() - startedAt) / 1000)), 500); return () => window.clearInterval(timer) }, [startedAt])
  const choose = (id: string, side: 'front' | 'back') => { if (matched.includes(id) || mistake.length) return; if (!selected) { setSelected({ id, side }); return } if (selected.id === id && selected.side !== side) { setMatched((previous) => [...previous, id]); setSelected(null) } else { setMistake([selected.id, id]); window.setTimeout(() => { setMistake([]); setSelected(null) }, 450) } }
  const restart = () => { const nextPairs = cards.slice(0, 6); setPairs(nextPairs); setTermTiles(shuffled(nextPairs)); setDefinitionTiles(shuffled(nextPairs)); setMatched([]); setSelected(null); setMistake([]); setStartedAt(Date.now()) }
  if (!pairs.length) return <StudyEmpty text="Add cards to play Match." />
  return <section className="match-study"><div className="match-header"><div><p className="eyebrow">MATCH</p><h1>{matched.length === pairs.length ? 'Complete.' : 'Make the pairs.'}</h1></div><span><Clock3 size={16} /> {Math.floor(time / 60)}:{String(time % 60).padStart(2, '0')}</span></div><p>Match each term with its definition. {matched.length === pairs.length && 'Nice work—try again to beat your time.'}</p><div className="match-grid"><div className="match-column">{termTiles.map((card) => <button key={`f-${card.id}`} onClick={() => choose(card.id, 'front')} className={`match-tile ${matched.includes(card.id) ? 'matched' : ''} ${selected?.id === card.id && selected.side === 'front' ? 'selected' : ''} ${mistake.includes(card.id) ? 'mistake' : ''}`}>{card.front}</button>)}</div><div className="match-column">{definitionTiles.map((card) => <button key={`b-${card.id}`} onClick={() => choose(card.id, 'back')} className={`match-tile ${matched.includes(card.id) ? 'matched' : ''} ${selected?.id === card.id && selected.side === 'back' ? 'selected' : ''} ${mistake.includes(card.id) ? 'mistake' : ''}`}>{card.back}</button>)}</div></div>{matched.length === pairs.length && <button className="button button-primary" onClick={restart}><RotateCcw size={16} /> Play again</button>}</section>
}

function StudyEmpty({ text }: { text: string }) { return <section className="study-empty"><Sparkles size={25} /><h1>Not quite ready.</h1><p>{text}</p></section> }
