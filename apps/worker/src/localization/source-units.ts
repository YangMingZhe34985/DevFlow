import { posix } from "node:path";
import { z } from "zod";
import { hash } from "./contracts.js";

const CallSchema = z.object({
  name: z.string(),
  receiver: z.string().nullable(),
  line: z.number(),
});
export const SourceUnitSchema = z.object({
  version: z.literal("static-source-unit-v1"),
  path: z.string(),
  sha256: z.string(),
  language: z.enum(["Python", "Java", "C++"]),
  parser: z.literal("LEXICAL_STATIC"),
  completeness: z.literal("PARTIAL"),
  definitions: z.array(
    z.object({
      name: z.string(),
      qualifier: z.string().nullable(),
      startLine: z.number(),
      endLine: z.number(),
      bodyStartLine: z.number(),
      kind: z.enum(["CLASS", "FUNCTION", "METHOD"]),
      implementation: z.boolean(),
      forwarding: z.boolean(),
      calls: z.array(CallSchema),
    }),
  ),
  dependencies: z.array(
    z.object({
      specifier: z.string(),
      line: z.number(),
      kind: z.enum(["IMPORT", "IMPLEMENTATION_PAIR"]),
      paths: z.array(z.string()),
      resolution: z.enum(["RESOLVED", "AMBIGUOUS", "UNRESOLVED"]),
      bindings: z.array(z.object({ local: z.string(), imported: z.string() })),
      provenance: z.string(),
    }),
  ),
  receivers: z.record(z.string(), z.string()),
  unknown: z.array(z.string()),
});
export type SourceUnit = z.infer<typeof SourceUnitSchema>;
export const staticSourceLanguage = (path: string): SourceUnit["language"] | undefined =>
  /\.py$/iu.test(path)
    ? "Python"
    : /\.java$/iu.test(path)
      ? "Java"
      : /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/iu.test(path)
        ? "C++"
        : undefined;

/** Strip comments/strings without moving line/character locations. Never execute repository code. */
export function maskSource(content: string, python: boolean): string {
  let output = "",
    i = 0;
  const blank = (text: string) => text.replace(/[^\r\n]/gu, " ");
  while (i < content.length) {
    const ch = content[i]!;
    if ((python && ch === "#") || (!python && content.startsWith("//", i))) {
      const end = content.indexOf("\n", i);
      const next = end < 0 ? content.length : end;
      output += blank(content.slice(i, next));
      i = next;
      continue;
    }
    if (!python && content.startsWith("/*", i)) {
      const end = content.indexOf("*/", i + 2),
        next = end < 0 ? content.length : end + 2;
      output += blank(content.slice(i, next));
      i = next;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = content.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      let end = i + quote.length;
      while (end < content.length) {
        if (content[end] === "\\") {
          end += 2;
          continue;
        }
        if (content.startsWith(quote, end)) {
          end += quote.length;
          break;
        }
        end++;
      }
      output += blank(content.slice(i, end));
      i = end;
      continue;
    }
    output += ch;
    i++;
  }
  return output;
}

const keywords = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof",
  "assert",
  "super",
]);
function callsIn(text: string, startLine: number): SourceUnit["definitions"][number]["calls"] {
  return [...text.matchAll(/\b((?:[A-Za-z_]\w*(?:\.|->|::))*)([A-Za-z_]\w*)\s*\(/gu)]
    .filter((m) => !keywords.has(m[2]!))
    .slice(0, 100)
    .map((m) => ({
      name: m[2]!,
      receiver: m[1] ? m[1].replace(/(?:\.|->|::)$/u, "") : null,
      line: startLine + text.slice(0, m.index).split("\n").length - 1,
    }));
}
function dependency(
  unit: SourceUnit,
  specifier: string,
  line: number,
  paths: string[],
  bindings: SourceUnit["dependencies"][number]["bindings"],
  provenance: string,
  kind: "IMPORT" | "IMPLEMENTATION_PAIR" = "IMPORT",
) {
  const unique = [...new Set(paths)].sort();
  unit.dependencies.push({
    specifier,
    line,
    paths: unique.slice(0, 8),
    bindings,
    provenance,
    kind,
    resolution: unique.length === 1 ? "RESOLVED" : unique.length ? "AMBIGUOUS" : "UNRESOLVED",
  });
  if (unique.length !== 1)
    unit.unknown.push(
      `${specifier}: ${unique.length ? "ambiguous source candidates" : "dependency not resolved in captured manifest"}`,
    );
}

export function parseStaticSource(
  path: string,
  content: string,
  paths: readonly string[] = [],
): SourceUnit | undefined {
  const language = staticSourceLanguage(path);
  if (!language || Buffer.byteLength(content) > 512 * 1024 || content.includes("\0"))
    return undefined;
  const unit: SourceUnit = {
    version: "static-source-unit-v1",
    path,
    sha256: hash(content),
    language,
    parser: "LEXICAL_STATIC",
    completeness: "PARTIAL",
    definitions: [],
    dependencies: [],
    receivers: {},
    unknown: [
      "Lexical declarations and explicit imports only; dynamic dispatch and runtime registration are unknown.",
    ],
  };
  const masked = maskSource(content, language === "Python");
  if (language === "Python") pythonUnit(unit, content, masked, paths);
  else if (language === "Java") javaUnit(unit, masked, paths);
  else cppUnit(unit, content, masked, paths);
  return unit;
}

function cppUnit(unit: SourceUnit, content: string, masked: string, paths: readonly string[]) {
  braceDefinitions(
    unit,
    masked.replace(/^\s*#.*$/gmu, (m) => m.replace(/[^\r\n]/gu, " ")),
  );
  const lines = masked.split("\n");
  for (const m of content.matchAll(/^[\t ]*#\s*include\s*["<]([^">\n]+)[">]/gmu)) {
    const line = content.slice(0, m.index).split("\n").length;
    if (!lines[line - 1]?.trim().startsWith("#")) continue;
    const relative = posix.normalize(posix.join(posix.dirname(unit.path), m[1]!));
    const exact = paths.filter((p) => p === relative);
    const candidates = exact.length
      ? exact
      : paths.filter((p) => p === m[1] || p.endsWith("/" + m[1]));
    dependency(
      unit,
      m[1]!,
      line,
      candidates,
      [],
      "Explicit C/C++ include; search paths and conditional compilation may be incomplete",
    );
  }
  const stem = posix.basename(unit.path).replace(/\.[^.]+$/u, "");
  const header = /\.(?:h|hh|hpp|hxx)$/iu.test(unit.path);
  const candidates = paths.filter(
    (p) =>
      p !== unit.path &&
      posix.basename(p).replace(/\.[^.]+$/u, "") === stem &&
      (header ? /\.(?:c|cc|cpp|cxx)$/iu : /\.(?:h|hh|hpp|hxx)$/iu).test(p),
  );
  if (candidates.length)
    dependency(
      unit,
      stem,
      1,
      candidates,
      [],
      "Same-stem header/implementation candidates; filename is not a semantic link",
      "IMPLEMENTATION_PAIR",
    );
  const ambiguousReceivers = new Set<string>();
  for (const m of masked.matchAll(
    /\b([A-Z]\w*)(?:<[^;{}()\n]{1,200}>)?\s*[*&]?\s+(\w+)\s*(?=[;=,)])/gu,
  )) {
    if (ambiguousReceivers.has(m[2]!)) continue;
    if (unit.receivers[m[2]!] && unit.receivers[m[2]!] !== m[1]) {
      delete unit.receivers[m[2]!];
      ambiguousReceivers.add(m[2]!);
      unit.unknown.push(`Ambiguous receiver ${m[2]}`);
    } else unit.receivers[m[2]!] = m[1]!;
  }
  if (/#\s*(?:if|ifdef|ifndef|define)|\b(?:template|virtual)\b/u.test(masked))
    unit.unknown.push(
      "Macros/templates/conditional compilation/virtual dispatch remain lexical candidates, not resolved call edges.",
    );
  unit.unknown.push(
    "C/C++ overloads, build include paths and namespace lookup are not compiler-verified.",
  );
}

/** Balanced bodies with masked strings/comments. This is deliberately not a compiler AST. */
function braceDefinitions(unit: SourceUnit, masked: string) {
  const pairs = new Map<number, number>(),
    stack: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") stack.push(i);
    else if (masked[i] === "}") {
      const start = stack.pop();
      if (start !== undefined) pairs.set(start, i);
    }
  }
  if (stack.length)
    unit.unknown.push("Unbalanced braces; incomplete bodies are not implementation evidence.");
  const lineAt = (offset: number) => masked.slice(0, offset).split("\n").length;
  const owners: { name: string; start: number; end: number; kind: string }[] = [];
  for (const m of masked.matchAll(
    /\b(class|interface|enum|record|struct|namespace)\s+(\w+)[^;{\n]*\{/gu,
  )) {
    const brace = m.index + m[0].lastIndexOf("{"),
      end = pairs.get(brace);
    if (end === undefined) continue;
    owners.push({ name: m[2]!, start: brace, end, kind: m[1]! });
    unit.definitions.push({
      name: m[2]!,
      qualifier: null,
      startLine: lineAt(m.index),
      endLine: lineAt(end),
      bodyStartLine: lineAt(brace),
      kind: "CLASS",
      implementation: false,
      forwarding: false,
      calls: [],
    });
  }
  const pattern =
    /^[\t ]*(?:[\w:<>,?*&[\].]+[\t ]+){0,8}((?:\w+::)*[~\w]+)\s*\(([^;{}]{0,2000})\)\s*(?:(?:const|noexcept|override|final)\b\s*|throws\s+[\w., \t]+\s*)*([;{])/gmu;
  for (const m of masked.matchAll(pattern)) {
    const name = m[1]!.split("::").at(-1)!;
    if (keywords.has(name) || unit.definitions.length >= 2000) continue;
    const declarationLine = lineAt(m.index);
    if (
      unit.definitions.some(
        (d) =>
          d.implementation && d.bodyStartLine < declarationLine && d.endLine >= declarationLine,
      )
    )
      continue;
    const brace = m.index + m[0].length - 1,
      end = m[3] === "{" ? pairs.get(brace) : brace;
    if (end === undefined) continue;
    const owner = owners
      .filter((o) => o.start < m.index && o.end > end)
      .sort((a, b) => b.start - a.start)[0];
    if (owner?.kind === "namespace" && /^(?:if|else|return|throw)\b/u.test(m[0].trim())) continue;
    const body = m[3] === "{" ? masked.slice(brace + 1, end) : "";
    const calls = callsIn(body, lineAt(brace));
    const statements = body
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const qualifier = m[1]!.includes("::")
      ? m[1]!.split("::").slice(0, -1).join("::")
      : (owner?.name ?? null);
    unit.definitions.push({
      name,
      qualifier,
      startLine: lineAt(m.index),
      endLine: lineAt(end),
      bodyStartLine: lineAt(brace),
      kind: qualifier ? "METHOD" : "FUNCTION",
      implementation: m[3] === "{",
      forwarding:
        statements.length <= 2 &&
        calls.length === 1 &&
        /^\s*(?:return\s+)?[\w.>:]+\([^;]*\);\s*$/u.test(body),
      calls,
    });
  }
  const methods = unit.definitions.filter((d) => d.kind !== "CLASS");
  for (const d of methods)
    if (
      methods.filter(
        (other) =>
          other.name === d.name &&
          other.qualifier === d.qualifier &&
          other.implementation === d.implementation,
      ).length > 1
    )
      unit.unknown.push(
        `Overloaded or conditional definition ${d.qualifier ?? ""}.${d.name}; parameter/dispatch resolution unknown.`,
      );
  return owners;
}

function javaUnit(unit: SourceUnit, masked: string, paths: readonly string[]) {
  const owners = braceDefinitions(unit, masked);
  const packageName = /\bpackage\s+([\w.]+)\s*;/u.exec(masked)?.[1] ?? "";
  const resolve = (name: string) => {
    const suffix = name.replaceAll(".", "/") + ".java";
    return paths.filter((p) => p === suffix || p.endsWith("/" + suffix));
  };
  const declared = new Set<string>();
  for (const m of masked.matchAll(/\bimport\s+(static\s+)?([\w.*]+)\s*;/gu)) {
    const parts = m[2]!.split("."),
      name = parts.at(-1)!;
    if (name === "*") {
      unit.unknown.push(`Wildcard import ${m[2]}: individual receiver resolution required.`);
      continue;
    }
    const target = m[1] ? parts.slice(0, -1).join(".") : m[2]!;
    dependency(
      unit,
      m[2]!,
      masked.slice(0, m.index).split("\n").length,
      resolve(target),
      [{ local: name, imported: name }],
      "Explicit Java import; class identity does not prove runtime dispatch",
    );
    declared.add(name);
  }
  const ambiguous = new Set<string>();
  for (const m of masked.matchAll(/\b([A-Z]\w*)(?:<[^;{}()\n]{1,200}>)?\s+(\w+)\s*(?=[;=,)])/gu)) {
    const type = m[1]!,
      receiver = m[2]!;
    if (unit.receivers[receiver] && unit.receivers[receiver] !== type) {
      ambiguous.add(receiver);
      delete unit.receivers[receiver];
      delete unit.receivers[`this.${receiver}`];
    }
    if (!ambiguous.has(receiver)) {
      unit.receivers[receiver] = type;
      unit.receivers[`this.${receiver}`] = type;
    }
    if (!declared.has(type) && !owners.some((o) => o.name === type)) {
      const candidates = resolve(packageName ? `${packageName}.${type}` : type);
      if (candidates.length)
        dependency(
          unit,
          type,
          masked.slice(0, m.index).split("\n").length,
          candidates,
          [{ local: type, imported: type }],
          "Declared receiver type in the same Java package; implementation dispatch unverified",
        );
      declared.add(type);
    }
  }
  if (ambiguous.size) unit.unknown.push(`Ambiguous receiver types: ${[...ambiguous].join(", ")}`);
  if (
    owners.some((o) => o.kind === "interface") ||
    /@(?:Inject|Autowired)|\bimplements\b/u.test(masked)
  )
    unit.unknown.push(
      "Interfaces/injection expose candidate declarations only; runtime implementation selection is unknown.",
    );
}

function pythonUnit(unit: SourceUnit, content: string, masked: string, paths: readonly string[]) {
  const lines = masked.split("\n");
  for (const [index, line] of lines.entries()) {
    const def = /^(\s*)(?:(?:async)\s+)?(def|class)\s+([A-Za-z_]\w*)/u.exec(line);
    if (!def || unit.definitions.length >= 2000) continue;
    const indent = def[1]!.replaceAll("\t", "    ").length;
    let body = index,
      colon = -1,
      nesting = 0;
    for (; body < Math.min(lines.length, index + 24); body++) {
      const header = lines[body]!;
      for (let j = body === index ? def[0].length : 0; j < header.length; j++) {
        const ch = header[j]!;
        if ("([{".includes(ch)) nesting++;
        if (")] }".replaceAll(" ", "").includes(ch)) nesting--;
        if (ch === ":" && nesting === 0) {
          colon = j;
          break;
        }
      }
      if (colon >= 0) break;
    }
    if (colon < 0) {
      unit.unknown.push(`Incomplete declaration at line ${index + 1}`);
      continue;
    }
    const inline = lines[body]!.slice(colon + 1).trim();
    let end = body + 1;
    while (
      end < lines.length &&
      (!lines[end]!.trim() ||
        lines[end]!.match(/^\s*/u)![0].replaceAll("\t", "    ").length > indent)
    )
      end++;
    const owner = unit.definitions.findLast(
      (d) => d.kind === "CLASS" && d.startLine < index + 1 && d.endLine >= end,
    );
    const text = [inline, ...lines.slice(body + 1, end)].join("\n"),
      calls = callsIn(text, body + 1);
    const statements = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    unit.definitions.push({
      name: def[3]!,
      qualifier: owner?.name ?? null,
      startLine: index + 1,
      endLine: Math.max(index + 1, end),
      bodyStartLine: body + (inline ? 1 : 2),
      kind: def[2] === "class" ? "CLASS" : owner ? "METHOD" : "FUNCTION",
      implementation: def[2] === "def" && statements.some((s) => s !== "..." && s !== "pass"),
      forwarding:
        def[2] === "def" &&
        statements.length <= 3 &&
        calls.length > 0 &&
        statements.every((s) => /^(?:return\s+)?[\w.]+\(.*\)\s*$/u.test(s)),
      calls,
    });
  }
  const resolve = (module: string) => {
    const dots = module.match(/^\.+/u)?.[0].length ?? 0;
    let stem: string;
    if (dots) {
      let directory = posix.dirname(unit.path);
      for (let i = 1; i < dots; i++) directory = posix.dirname(directory);
      stem = posix.join(directory, module.slice(dots).replaceAll(".", "/"));
      return paths.filter((p) => p === stem + ".py" || p === posix.join(stem, "__init__.py"));
    }
    stem = module.replaceAll(".", "/");
    return paths.filter(
      (p) =>
        p === stem + ".py" ||
        p.endsWith("/" + stem + ".py") ||
        p === stem + "/__init__.py" ||
        p.endsWith("/" + stem + "/__init__.py"),
    );
  };
  for (const [index, line] of lines.entries()) {
    const from = /^\s*from\s+([.\w]+)\s+import\s+(.+)/u.exec(line);
    const imp = /^\s*import\s+([\w., ]+(?:\s+as\s+\w+)?)/u.exec(line);
    if (from) {
      let bindingText = from[2]!;
      if (bindingText.includes("("))
        for (
          let i = index + 1;
          i < Math.min(lines.length, index + 16) && !bindingText.includes(")");
          i++
        )
          bindingText += " " + lines[i];
      const bindings = [...bindingText.matchAll(/\b(\w+)(?:\s+as\s+(\w+))?/gu)]
        .filter((m) => m[1] !== "as")
        .map((m) => ({ local: m[2] ?? m[1]!, imported: m[1]! }));
      let targets = resolve(from[1]!);
      if (!targets.length && bindings.length === 1)
        targets = resolve(from[1] + (from[1]!.endsWith(".") ? "" : ".") + bindings[0]!.imported);
      dependency(
        unit,
        from[1]!,
        index + 1,
        targets,
        bindings,
        "Explicit Python from/import declaration",
      );
    } else if (imp) {
      for (const segment of imp[1]!.split(",")) {
        const match = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/u.exec(segment);
        if (match)
          dependency(
            unit,
            match[1]!,
            index + 1,
            resolve(match[1]!),
            [{ local: match[2] ?? match[1]!, imported: "*" }],
            "Explicit Python import declaration",
          );
      }
    }
  }
  const types = new Map<string, string>(),
    ambiguousTypes = new Set<string>();
  const remember = (receiver: string, type: string) => {
    if (ambiguousTypes.has(receiver)) return;
    if (types.has(receiver) && types.get(receiver) !== type) {
      ambiguousTypes.add(receiver);
      types.delete(receiver);
      unit.unknown.push(`Ambiguous Python receiver ${receiver}: scope or runtime type unresolved.`);
    } else types.set(receiver, type);
  };
  for (const m of masked.matchAll(/\b((?:self\.)?\w+)\s*:\s*([A-Z]\w*)/gu)) remember(m[1]!, m[2]!);
  for (const m of masked.matchAll(/\b(self\.\w+)\s*=\s*([A-Za-z_]\w*)\s*(\()?/gu)) {
    const type = m[3] && /^[A-Z]/u.test(m[2]!) ? m[2]! : types.get(m[2]!);
    if (type) remember(m[1]!, type);
  }
  unit.receivers = Object.fromEntries(types);
  if (/^\s*@/mu.test(content))
    unit.unknown.push(
      "Decorators may alter runtime binding; declarations do not establish runtime dispatch.",
    );
}
