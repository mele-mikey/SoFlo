export function isolateMechanicalChange(original: string, replacement: string) {
  const originalParts = original.match(/\s+|\S+/g) ?? []
  const replacementParts = replacement.match(/\s+|\S+/g) ?? []
  let prefix = 0
  while (prefix < originalParts.length && prefix < replacementParts.length && originalParts[prefix].toLocaleLowerCase() === replacementParts[prefix].toLocaleLowerCase()) prefix += 1
  let originalEnd = originalParts.length
  let replacementEnd = replacementParts.length
  while (originalEnd > prefix && replacementEnd > prefix && originalParts[originalEnd - 1].toLocaleLowerCase() === replacementParts[replacementEnd - 1].toLocaleLowerCase()) {
    originalEnd -= 1
    replacementEnd -= 1
  }
  const narrowedOriginal = originalParts.slice(prefix, originalEnd).join('').trim()
  const narrowedReplacement = replacementParts.slice(prefix, replacementEnd).join('').trim()
  return narrowedOriginal && narrowedReplacement ? { original: narrowedOriginal, replacement: narrowedReplacement } : { original, replacement }
}
