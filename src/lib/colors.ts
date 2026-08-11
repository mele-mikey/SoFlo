export type SoFloPresetColor = { name: string; value: string }

// These are the shared content colors used for classes, Study Web groups, and
// future colored workspace objects. Editor text and highlighting remain their
// own unrestricted color systems.
export const SOFLO_PRESET_COLORS: SoFloPresetColor[] = [
  { name: 'Violet', value: '#7E70D6' },
  { name: 'Lavender', value: '#A18AE6' },
  { name: 'Blue', value: '#4E86D9' },
  { name: 'Sky', value: '#73A8E8' },
  { name: 'Teal', value: '#348E8C' },
  { name: 'Aqua', value: '#62B8B0' },
  { name: 'Green', value: '#4C9A72' },
  { name: 'Mint', value: '#76BB8D' },
  { name: 'Gold', value: '#C49A43' },
  { name: 'Honey', value: '#E2BF66' },
  { name: 'Orange', value: '#C87948' },
  { name: 'Apricot', value: '#E5A369' },
  { name: 'Rose', value: '#C85D6E' },
  { name: 'Blush', value: '#E28998' },
]

export const DEFAULT_SOFLO_PRESET_COLOR = SOFLO_PRESET_COLORS[0].value
