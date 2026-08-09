import { describe, expect, it } from 'vitest'
import { importPdfAsEditableNote } from './pdfImport'

describe('importPdfAsEditableNote', () => {
  it('turns common PDF text structure into editable rich-text nodes', () => {
    const imported = importPdfAsEditableNote('Michael Mele\n\nMrs. Swanigan\n\nArgument Essay\n\n Students Free Speech\n\n  This is the first paragraph with a wrapped line.\n\nthat stays in the same paragraph.\n\n  This is the next paragraph.\n\n- Read chapter one\n\n- Review the slides\n\f\n1. Make a plan\n\n2. Test yourself', 'C:/Downloads/study-guide.pdf')
    expect(imported.title).toBe('Students Free Speech')
    expect(imported.document.content.map((node) => node.type)).toContain('heading')
    expect(imported.document.content.filter((node) => node.type === 'paragraph')).toHaveLength(5)
    expect(imported.document.content.map((node) => node.type)).toContain('bulletList')
    expect(imported.document.content.map((node) => node.type)).toContain('orderedList')
    expect(imported.document.content.map((node) => node.type)).toContain('horizontalRule')
  })
})
