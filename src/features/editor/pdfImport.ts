type TipTapNode = {
  type: string
  attrs?: Record<string, string | number>
  marks?: { type: string }[]
  content?: TipTapNode[]
  text?: string
}

export interface ImportedPdfNote {
  title: string
  document: { type: 'doc'; content: TipTapNode[] }
  plainText: string
}

const clean = (value: string) => value.replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim()
const textNode = (text: string): TipTapNode[] => text ? text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) => part.startsWith('**') && part.endsWith('**') ? { type: 'text', text: part.slice(2, -2), marks: [{ type: 'bold' }] } as TipTapNode : { type: 'text', text: part }) : []
const paragraph = (text: string): TipTapNode => ({ type: 'paragraph', content: textNode(clean(text)) })
const listItem = (text: string): TipTapNode => ({ type: 'listItem', content: [paragraph(text)] })
const startsIndented = (line: string) => /^(?: {2,}|\t)/.test(line)
const explicitHeading = (line: string) => /^works cited$/i.test(line) || (/^[A-Z0-9][A-Z0-9 .,'\u2019-]{2,}$/.test(line) && line.length <= 80)
const bulletPattern = /^(?:[\u2022\u25e6\u25aa\u2023*-]|\u2013)\s+(.+)$/
const orderedPattern = /^(\d+|[A-Za-z])[.)]\s+(.+)$/

function pageNodes(page: string): TipTapNode[] {
  const rawLines = page.replace(/\r/g, '').split('\n')
  const firstBodyLine = rawLines.findIndex((line) => startsIndented(line) && clean(line).length > 0)
  const nodes: TipTapNode[] = []
  let paragraphLines: string[] = []
  const flushParagraph = () => {
    const value = clean(paragraphLines.join(' '))
    if (value) nodes.push(paragraph(value))
    paragraphLines = []
  }

  // Google Docs preserves first-line paragraph indents in its PDF text stream. The
  // preceding lines are a heading block; its final line is the paper title.
  const bodyStart = firstBodyLine > 0 ? firstBodyLine : 0
  if (bodyStart > 0) {
    const headingBlock = rawLines.slice(0, bodyStart).map(clean).filter(Boolean)
    headingBlock.forEach((line, index) => {
      const isTitle = index === headingBlock.length - 1
      nodes.push(isTitle ? { type: 'heading', attrs: { level: 1 }, content: textNode(line) } : paragraph(line))
    })
  }

  for (let index = bodyStart; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index]
    const line = clean(rawLine)
    // pdf-extract emits a blank line after visual lines. Indentation, not that
    // transport spacing, tells us where a Google Docs paragraph begins.
    if (!line) continue

    const bulletMatch = line.match(bulletPattern)
    const orderedMatch = line.match(orderedPattern)
    if (bulletMatch || orderedMatch) {
      flushParagraph()
      const type = orderedMatch ? 'orderedList' : 'bulletList'
      const items: TipTapNode[] = []
      for (; index < rawLines.length; index += 1) {
        const candidate = clean(rawLines[index])
        if (!candidate) continue
        const match = orderedMatch ? candidate.match(orderedPattern) : candidate.match(bulletPattern)
        if (!match) { index -= 1; break }
        items.push(listItem(match[match.length - 1]))
      }
      nodes.push({ type, content: items })
      continue
    }

    if (explicitHeading(line)) {
      flushParagraph()
      nodes.push({ type: 'heading', attrs: { level: 2 }, content: textNode(line) })
      continue
    }

    if (startsIndented(rawLine) && paragraphLines.length) flushParagraph()
    paragraphLines.push(line)
  }
  flushParagraph()
  return nodes
}

function sourceName(path: string) {
  const file = path.split(/[\\/]/).pop() ?? 'Imported PDF'
  return clean(file.replace(/\.(pdf|docx)$/i, '')) || 'Imported document'
}

export function importPdfAsEditableNote(text: string, path: string): ImportedPdfNote {
  const pages = text.split('\f').map((page) => page.trim()).filter(Boolean)
  const content = pages.flatMap((page, index) => {
    const nodes = pageNodes(page)
    return index === 0 ? nodes : [{ type: 'horizontalRule' } as TipTapNode, ...nodes]
  })
  const firstHeading = content.find((node) => node.type === 'heading')?.content?.[0]?.text
  return {
    title: firstHeading || sourceName(path),
    document: { type: 'doc', content: content.length ? content : [paragraph('')] },
    plainText: pages.join('\n\n').replace(/\s+\n/g, '\n').trim(),
  }
}

export function importAiFormattedNote(markdown: string, path: string): ImportedPdfNote {
  const cleanedMarkdown = markdown.replace(/\r/g, '').replace(/^\s*```(?:markdown|md)?\s*$/gim, '').replace(/^\s*```\s*$/gm, '').trim()
  const lines = cleanedMarkdown.split('\n')
  const content: TipTapNode[] = []
  let listType: 'bulletList' | 'orderedList' | null = null
  let items: TipTapNode[] = []
  const flushList = () => { if (listType && items.length) content.push({ type: listType, content: items }); listType = null; items = [] }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) { flushList(); continue }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    const bullet = line.match(/^[-*+]\s+(.+)$/)
    const ordered = line.match(/^\d+[.)]\s+(.+)$/)
    if (heading) { flushList(); content.push({ type: 'heading', attrs: { level: Math.min(3, heading[1].length) }, content: textNode(heading[2]) }); continue }
    if (bullet || ordered) { const nextType = bullet ? 'bulletList' : 'orderedList'; if (listType && listType !== nextType) flushList(); listType = nextType; items.push(listItem((bullet ?? ordered)![1])); continue }
    flushList(); content.push(paragraph(line))
  }
  flushList()
  const firstHeading = content.find((node) => node.type === 'heading')?.content?.[0]?.text
  return { title: firstHeading || sourceName(path), document: { type: 'doc', content: content.length ? content : [paragraph('')] }, plainText: cleanedMarkdown.replace(/^#{1,6}\s+/gm, '').replace(/^[-*+]\s+/gm, '').trim() }
}
