import { describe, expect, it } from 'vitest'
import { isolateMechanicalChange } from './grammar'

describe('isolateMechanicalChange', () => {
  it('keeps a split-word correction when the model returns sentence context', () => {
    expect(isolateMechanicalChange('had alot to do with taxes', 'had a lot to do with taxes')).toEqual({ original: 'alot', replacement: 'a lot' })
  })

  it('keeps a single spelling correction when the model returns a whole sentence', () => {
    expect(isolateMechanicalChange('It took pace on December 16', 'It took place on December 16')).toEqual({ original: 'pace', replacement: 'place' })
  })
})
