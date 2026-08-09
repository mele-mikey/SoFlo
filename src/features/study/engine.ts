import type { Flashcard } from '../../lib/types'
import { normalizeAnswer } from '../../lib/format'

export type StudyQuestion =
  | { id: string; cardId: string; type: 'multipleChoice'; prompt: string; answer: string; choices: string[] }
  | { id: string; cardId: string; type: 'written'; prompt: string; answer: string }
  | { id: string; cardId: string; type: 'trueFalse'; prompt: string; answer: boolean; shownDefinition: string }

export interface TestOptions {
  count: number
  multipleChoice: boolean
  written: boolean
  trueFalse: boolean
  starredOnly: boolean
  definitionFirst: boolean
  shuffle: boolean
}

export function shuffled<T>(items: T[]): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

function choicesFor(card: Flashcard, allCards: Flashcard[], definitionFirst: boolean): string[] {
  const correct = definitionFirst ? card.front : card.back
  const alternatives = shuffled(allCards.filter((item) => item.id !== card.id).map((item) => definitionFirst ? item.front : item.back).filter((value) => value.trim() && value !== correct)).slice(0, 3)
  return shuffled([correct, ...alternatives])
}

export function createQuestion(card: Flashcard, allCards: Flashcard[], type: StudyQuestion['type'], definitionFirst = false): StudyQuestion {
  const prompt = definitionFirst ? card.back : card.front
  const answer = definitionFirst ? card.front : card.back
  if (type === 'multipleChoice') return { id: crypto.randomUUID(), cardId: card.id, type, prompt, answer, choices: choicesFor(card, allCards, definitionFirst) }
  if (type === 'written') return { id: crypto.randomUUID(), cardId: card.id, type, prompt, answer }
  const hasAlternative = allCards.some((item) => item.id !== card.id)
  const showCorrect = !hasAlternative || Math.random() > 0.45
  const alternative = shuffled(allCards.filter((item) => item.id !== card.id))[0]
  return { id: crypto.randomUUID(), cardId: card.id, type, prompt: card.front, answer: showCorrect, shownDefinition: showCorrect ? card.back : alternative?.back ?? card.back }
}

export function createTest(cards: Flashcard[], options: TestOptions): StudyQuestion[] {
  const eligible = options.starredOnly ? cards.filter((card) => card.isStarred) : cards
  const source = options.shuffle ? shuffled(eligible) : eligible
  const chosen = source.slice(0, Math.min(options.count, source.length))
  const types = ([options.multipleChoice && 'multipleChoice', options.written && 'written', options.trueFalse && 'trueFalse'].filter(Boolean) as StudyQuestion['type'][])
  const allowedTypes: StudyQuestion['type'][] = types.length ? types : ['multipleChoice']
  return chosen.map((card, index) => createQuestion(card, eligible, allowedTypes[index % allowedTypes.length] ?? 'multipleChoice', options.definitionFirst))
}

export function isCorrect(question: StudyQuestion, response: string | boolean): boolean {
  if (question.type === 'trueFalse') return response === question.answer
  if (question.type === 'multipleChoice') return response === question.answer
  return normalizeAnswer(String(response)) === normalizeAnswer(question.answer)
}
