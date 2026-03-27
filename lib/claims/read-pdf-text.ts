type ParsedPdfText = {
  text: string
  parseFailed: boolean
}

function normalizeText(input: string): string {
  return input
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function parseWithModule(pdfBytes: Buffer): Promise<string | null> {
  const moduleExports = (await import('pdf-parse')) as Record<string, unknown>

  const pdfParseDefault = moduleExports.default
  if (typeof pdfParseDefault === 'function') {
    const parsed = (await (pdfParseDefault as (input: Buffer | Uint8Array) => Promise<{ text?: string }>)(
      pdfBytes
    )) as { text?: string }

    if (parsed && typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
      return parsed.text
    }
  }

  const PdfParseClass = moduleExports.PDFParse
  if (typeof PdfParseClass === 'function') {
    const parser = new (PdfParseClass as new (input: { data: Uint8Array }) => { getText: () => Promise<{ text?: string }>; destroy: () => Promise<void> })({
      data: new Uint8Array(pdfBytes)
    })

    try {
      const parsed = await parser.getText()
      if (parsed && typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
        return parsed.text
      }
    } finally {
      await parser.destroy()
    }
  }

  return null
}

export async function readPdfTextConservatively(pdfBytes: Buffer): Promise<ParsedPdfText> {
  try {
    const parsedText = await parseWithModule(pdfBytes)
    const normalized = normalizeText(parsedText || '')

    if (normalized.length > 0) {
      return {
        text: normalized,
        parseFailed: false
      }
    }
  } catch {
    // Fall back to conservative text decode.
  }

  return {
    text: normalizeText(pdfBytes.toString('latin1')),
    parseFailed: true
  }
}
