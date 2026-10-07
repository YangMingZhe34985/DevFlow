/** Natural-language task text only. Code evidence must retain literal matching. */
export function matchTaskQuote(source: string, quote: string) {
  const normalize = (text: string) => {
    let value = "";
    const offsets: number[] = [];
    for (const token of text.matchAll(/\S+/gu)) {
      if (value) {
        value += " ";
        offsets.push(token.index - 1);
      }
      value += token[0];
      for (let i = 0; i < token[0].length; i++) offsets.push(token.index + i);
    }
    return { value, offsets };
  };
  const original = normalize(source),
    requested = normalize(quote).value;
  if (!requested) return undefined;
  const index = original.value.indexOf(requested);
  if (index < 0) return undefined;
  const start = original.offsets[index]!,
    end = original.offsets[index + requested.length - 1]! + 1;
  return {
    start,
    end,
    original: source.slice(start, end),
    matching: "WHITESPACE_EQUIVALENT" as const,
  };
}
