/** Restore literal newline escapes in displayed prose only; never rewrite stored messages. */
export function displayMessageNewlines(text: string): string {
  // Keep Markdown code and Windows paths verbatim. An unfinished code span/block is
  // protected to the end as well, so streaming cannot rewrite code before it closes.
  const tokens = /^ {0,3}(?<fence>`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)|(?<inline>`+)|(?:[A-Za-z]:\\|\\\\)[^\s`<>]*|\\r\\n|\\n/gm;
  let result = '', offset = 0;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(text)) !== null) {
    result += text.slice(offset, token.index);
    const fence = token.groups?.fence, inline = token.groups?.inline;
    if (fence || inline) {
      const closing = fence
        ? new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*\\r?$`, 'gm')
        : new RegExp(`(?<!\x60)\x60{${inline!.length}}(?!\x60)`, 'g');
      closing.lastIndex = tokens.lastIndex;
      const end = closing.exec(text);
      tokens.lastIndex = end ? closing.lastIndex : text.length;
      result += text.slice(token.index, tokens.lastIndex);
    } else {
      result += token[0] === '\\n' || token[0] === '\\r\\n' ? '\n' : token[0];
    }
    offset = tokens.lastIndex;
  }
  return result + text.slice(offset);
}
