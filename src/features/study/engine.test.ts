import { describe, expect, it } from 'vitest'
import { createQuestion, createTest, isCorrect } from './engine'
import type { Flashcard } from '../../lib/types'

const cards: Flashcard[] = [
  { id: 'a', setId: 'set', front: 'Mitosis', back: 'Cell division producing two identical cells', notes: null, imagePath: null, position: 0, isStarred: true, createdAt: '', updatedAt: '' },
  { id: 'b', setId: 'set', front: 'Meiosis', back: 'Cell division producing reproductive cells', notes: null, imagePath: null, position: 1, isStarred: false, createdAt: '', updatedAt: '' },
  { id: 'c', setId: 'set', front: 'Osmosis', back: 'Movement of water across a membrane', notes: null, imagePath: null, position: 2, isStarred: false, createdAt: '', updatedAt: '' },
]

describe('study question engine', () => {
  it('includes the correct answer in multiple-choice options', () => {
    const question = createQuestion(cards[0]!, cards, 'multipleChoice')
    expect(question.type).toBe('multipleChoice')
    if (question.type === 'multipleChoice') expect(question.choices).toContain(cards[0]!.back)
  })

  it('normalizes insignificant written-answer differences', () => {
    const question = createQuestion(cards[2]!, cards, 'written')
    expect(isCorrect(question, ' movement of water across a membrane! ')).toBe(true)
  })

  it('respects starred-only test selection and count', () => {
    const test = createTest(cards, { count: 8, multipleChoice: true, written: false, trueFalse: false, starredOnly: true, definitionFirst: false, shuffle: false })
    expect(test).toHaveLength(1)
    expect(test[0]?.cardId).toBe('a')
    expect(test[0]?.type).toBe('multipleChoice')
  })

  it('grades true-false questions based on their pairing state', () => {
    const question = { id: 'x', cardId: 'a', type: 'trueFalse' as const, prompt: 'Mitosis', answer: false, shownDefinition: cards[1]!.back }
    expect(isCorrect(question, false)).toBe(true)
    expect(isCorrect(question, true)).toBe(false)
  })

  it('keeps a single-card true-false prompt valid', () => {
    const question = createQuestion(cards[0]!, [cards[0]!], 'trueFalse')
    expect(question.type).toBe('trueFalse')
    if (question.type === 'trueFalse') {
      expect(question.answer).toBe(true)
      expect(question.shownDefinition).toBe(cards[0]!.back)
    }
  })
})
