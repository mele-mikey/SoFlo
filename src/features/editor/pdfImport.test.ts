import { describe, expect, it } from 'vitest'
import { importAiFormattedNote, importPdfAsEditableNote, isLikelyMlaPaperImport } from './pdfImport'

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

  it('restores an MLA heading block when the formatter omits it', () => {
    const source = 'Michael Mele\nMrs. Swanigan\nArgument Essay\n10/31/2024\n\n Students Free Speech\n\n  First body paragraph.'
    const imported = importAiFormattedNote('# Students Free Speech\n\nFirst body paragraph.', 'C:/Downloads/argument.pdf', source)
    expect(imported.document.content.slice(0, 4).map((node) => node.content?.[0]?.text)).toEqual(['Michael Mele', 'Mrs. Swanigan', 'Argument Essay', '10/31/2024'])
    expect(imported.document.content[4].type).toBe('heading')
  })

  it('keeps exactly one MLA heading block when the formatter returns its own copy', () => {
    const source = 'Michael Mele\nMrs. Swanigan\nArgument Essay\n10/31/2024\n\n Students Free Speech\n\n  First body paragraph.'
    const markdown = '# Students Free Speech\n\nMichael Mele\n\nMrs. Swanigan\n\nArgument Essay\n\n10/31/2024\n\nFirst body paragraph.'
    const imported = importAiFormattedNote(markdown, 'C:/Downloads/argument.pdf', source)
    expect(imported.document.content.filter((node) => node.content?.[0]?.text === 'Michael Mele')).toHaveLength(1)
    expect(imported.document.content.slice(0, 4).map((node) => node.content?.[0]?.text)).toEqual(['Michael Mele', 'Mrs. Swanigan', 'Argument Essay', '10/31/2024'])
  })

  it('rebuilds a visual-line MLA extraction without turning every wrapped line into a paragraph', () => {
    const source = `Michael Mele

Mrs. Swanigan

Argument Essay

10/31/2024

Students Free Speech: When Do We Draw The Line?

In 2009 a middle school student posted a video on YouTube about rude comments on a

classmate, and the school suspended her (Liebman par. 3). Schools should not be allowed to discipline students

based on what they say on social media, it is a flagrant violation of the students’ First Amendment Rights and should not be

taken lightly.

Students should have the right to free speech as given by their First Amendment Rights,

however, with some limits similar to adults. Student speech has been a widely debated topic,

especially in the past few years.`
    expect(isLikelyMlaPaperImport(source)).toBe(true)
    const imported = importPdfAsEditableNote(source, 'C:/Downloads/argument.pdf')
    expect(imported.title).toBe('Students Free Speech: When Do We Draw The Line?')
    expect(imported.document.content[4].attrs).toMatchObject({ level: 1, textAlign: 'center' })
    const body = imported.document.content.filter((node) => node.type === 'paragraph' && node.attrs?.firstLineIndent === 1)
    expect(body).toHaveLength(2)
    expect(body[0].content?.[0]?.text).toContain('taken lightly.')
  })

  it('rejects an unformatted model echo in favor of the source-preserving MLA parser', () => {
    const source = 'Michael Mele\nMrs. Swanigan\nArgument Essay\n10/31/2024\nStudents Free Speech\n\nA wrapped first sentence that ends short.\n\nA second paragraph that is also complete.'
    const imported = importAiFormattedNote(source, 'C:/Downloads/argument.pdf', source)
    expect(imported.document.content[4].type).toBe('heading')
    expect(imported.document.content.filter((node) => node.type === 'paragraph' && node.attrs?.firstLineIndent === 1)).toHaveLength(2)
  })

  it('keeps wrapped Works Cited entries together and applies a hanging indent', () => {
    const source = 'Michael Mele\nMrs. Swanigan\nArgument Essay\n10/31/2024\nStudents Free Speech\n\nA complete body paragraph.\n\nWorks Cited\n\n“Free Speech in High School.” Foundation for Individual Rights in Education, 2021.\n\nCommonLit, https://www.commonlit.org/example. Accessed October 31, 2024.\n\nLiebman, Jennifer. “School Speech.” Example Journal, 2024.'
    const imported = importPdfAsEditableNote(source, 'C:/Downloads/argument.pdf')
    const citations = imported.document.content.filter((node) => node.type === 'paragraph' && node.attrs?.hangingIndent === 1)
    expect(citations).toHaveLength(2)
    expect(citations[0].content?.[0]?.text).toContain('CommonLit')
  })

  it('turns generic AI Markdown into editable headings, lists, tables, and intentional line breaks', () => {
    const markdown = `# Course packet

## Overview
This sentence was visually wrapped
in the source PDF, so it remains one paragraph.

- First topic
- Second topic

1. Review the material
2. Check your notes

| Task | Weight |
| --- | --- |
| Quiz | 10% |

Line one<br>
Line two`
    const imported = importAiFormattedNote(markdown, 'C:/Downloads/course-packet.pdf')
    expect(imported.document.content.map((node) => node.type)).toEqual(expect.arrayContaining(['heading', 'bulletList', 'orderedList', 'table']))
    const paragraphWithHardBreak = imported.document.content.find((node) => node.type === 'paragraph' && node.content?.some((child) => child.type === 'hardBreak'))
    expect(paragraphWithHardBreak?.content?.map((child) => child.text ?? child.type).join('')).toContain('Line two')
  })

})
