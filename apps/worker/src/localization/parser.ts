import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

import { z } from "zod";

export const PARSER_VERSION = "typescript-5.9.3-declarations-v2-512k";
export const ParsedFileSchema = z.object({
  status: z.enum(["PARSED", "LEXICAL", "PARSE_ERROR"]),
  symbols: z
    .array(
      z.object({
        name: z.string().max(256),
        signature: z.string().max(512),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
      }),
    )
    .max(2000),
  imports: z
    .array(
      z.object({
        specifier: z.string().max(512),
        kind: z.enum(["import", "export"]),
        line: z.number().int().positive(),
      }),
    )
    .max(500),
});
export type ParsedFile = z.infer<typeof ParsedFileSchema>;

// Parsing is data-only; repository code is never imported or executed. The worker has no credentials.
const script = `
const { parentPort, workerData } = require('node:worker_threads');
const ts = require(workerData.typescript);
const source = ts.createSourceFile('source.' + workerData.extension, workerData.content, ts.ScriptTarget.Latest, true);
const symbols = [], imports = [];
function visit(node) {
  if (symbols.length < 2000 && node.name && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node))) {
    const start = node.getStart(source), end = node.getEnd();
    symbols.push({name: node.name.getText(source).slice(0,256), signature: source.text.slice(start, Math.min(end, node.body ? node.body.getStart(source) : start + 512)).slice(0,512), startLine: source.getLineAndCharacterOfPosition(start).line + 1, endLine: source.getLineAndCharacterOfPosition(end).line + 1});
  }
  if (imports.length < 500 && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push({specifier:node.moduleSpecifier.text.slice(0,512),kind:ts.isImportDeclaration(node)?'import':'export',line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1});
  ts.forEachChild(node, visit);
}
visit(source);
parentPort.postMessage({status:source.parseDiagnostics.length?'PARSE_ERROR':'PARSED',symbols,imports});
`;

let activeParsers = 0;
const parserWaiters: (() => void)[] = [];

export async function acquireParser(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (activeParsers >= 4) {
    if (parserWaiters.length >= 128) throw new Error("Parser admission limit reached");
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        const index = parserWaiters.indexOf(ready);
        if (index >= 0) parserWaiters.splice(index, 1);
        reject(signal.reason);
      };
      parserWaiters.push(ready);
      signal.addEventListener("abort", aborted, { once: true });
    });
  } else activeParsers++;
  return () => {
    const next = parserWaiters.shift();
    if (next === undefined) activeParsers--;
    else next();
  };
}

export async function parseCandidate(
  content: string,
  extension: string,
  signal: AbortSignal,
): Promise<ParsedFile> {
  const release = await acquireParser(signal);
  try {
    return await parseInWorker(content, extension, signal);
  } finally {
    release();
  }
}

async function parseInWorker(
  content: string,
  extension: string,
  signal: AbortSignal,
): Promise<ParsedFile> {
  signal.throwIfAborted();
  if (!/^(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(extension)) {
    return { status: "LEXICAL", symbols: [], imports: [] };
  }
  if (Buffer.byteLength(content) > 512 * 1024) throw new Error("Parser input exceeds 512 KiB");
  const worker = new Worker(script, {
    eval: true,
    env: {},
    workerData: {
      content,
      extension,
      typescript: createRequire(import.meta.url).resolve("typescript"),
    },
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  return await new Promise<ParsedFile>((resolve, reject) => {
    const finish = (error?: unknown, value?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error !== undefined) reject(error);
      else {
        const parsed = ParsedFileSchema.safeParse(value);
        if (parsed.success) resolve(parsed.data);
        else reject(new Error("Invalid parser worker output"));
      }
    };
    const abort = () => finish(signal.reason ?? new Error("Parsing cancelled"));
    const timer = setTimeout(() => finish(new Error("Parser deadline exceeded")), 5_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: unknown) => finish(undefined, value));
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`Parser exited: ${code}`));
    });
  });
}
