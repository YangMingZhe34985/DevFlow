/** A reference replaces bytes only when a same-version visible record contains them verbatim. */
export interface ContextSourceRange {
  id: string;
  path: string;
  fileSha256: string;
  startLine: number;
  endLine: number;
  content: string;
}

export function sourceRangeReferences(records: readonly ContextSourceRange[]) {
  const valid = records.filter((r) => {
    const lines = r.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    return (
      /^[a-f0-9]{64}$/u.test(r.fileSha256) &&
      Number.isInteger(r.startLine) &&
      r.startLine > 0 &&
      Number.isInteger(r.endLine) &&
      r.endLine >= r.startLine &&
      lines.length === r.endLine - r.startLine + 1
    );
  });
  // Longest record first; equal ranges prefer the latest observation. Owners never point onwards.
  const ordered = [...valid].reverse().sort((a, b) => b.content.length - a.content.length);
  const owners: ContextSourceRange[] = [];
  const references = new Map<string, ContextSourceRange>();
  for (const record of ordered) {
    const owner = owners.find((candidate) => {
      if (
        candidate.path !== record.path ||
        candidate.fileSha256 !== record.fileSha256 ||
        candidate.startLine > record.startLine ||
        candidate.endLine < record.endLine
      )
        return false;
      const lines = candidate.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      const covered = lines
        .slice(record.startLine - candidate.startLine, record.endLine - candidate.startLine + 1)
        .join("");
      // readFile commonly omits the separator after its last selected line. Interior bytes
      // must still match exactly; references carry the requested terminal separator.
      return (
        covered === record.content ||
        (!record.content.endsWith("\n") && covered.replace(/\r?\n$/u, "") === record.content)
      );
    });
    if (owner && Buffer.byteLength(record.content) > 512) references.set(record.id, owner);
    else owners.push(record);
  }
  return references;
}
