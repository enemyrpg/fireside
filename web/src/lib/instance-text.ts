// The instance text is plain text: paragraphs separated by a blank line, single
// line breaks kept. Never parsed as HTML or Markdown.

/** The paragraphs of an instance text. */
export function instanceParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}
