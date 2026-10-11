import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { posix } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { hash } from "./contracts.js";
import { resourceBudgetContext } from "../runs/resource-budget-runtime.js";
import { acquireParser } from "./parser.js";
import { parseStaticSource, staticSourceLanguage, type SourceUnit } from "./source-units.js";

export const PRG_PARSER_VERSION = "vscode-tree-sitter-wasm-0.3.1/prg-1";
export const SyntaxFactsSchema = z.object({
  status: z.enum(["PARSED", "PARSE_ERROR"]),
  truncated: z.boolean(),
  declarations: z
    .array(
      z.object({
        name: z.string(),
        qualifier: z.string().nullable(),
        kind: z.enum(["CLASS", "FUNCTION", "METHOD"]),
        startLine: z.number(),
        endLine: z.number(),
        bodyStartLine: z.number(),
        implementation: z.boolean(),
      }),
    )
    .max(1000),
  imports: z
    .array(z.object({ text: z.string(), startLine: z.number(), endLine: z.number() }))
    .max(1000),
  references: z.array(z.object({ name: z.string(), line: z.number() })).max(4000),
  calls: z
    .array(z.object({ name: z.string(), receiver: z.string().nullable(), line: z.number() }))
    .max(1000),
});
export type SyntaxFacts = z.infer<typeof SyntaxFactsSchema>;
export const PrgFactsSchema = z.object({
  parserVersion: z.string(),
  sourceSha: z.string(),
  configurationHash: z.string(),
  syntax: SyntaxFactsSchema,
  coverage: z.literal("PARTIAL"),
});
export type PrgFacts = z.infer<typeof PrgFactsSchema>;

// Only trusted parser modules/grammars are loaded. Repository text is data in an empty-env worker.
const script = String.raw`
const {parentPort,workerData:d}=require('node:worker_threads');
(async()=>{
 const {Parser,Language}=require(d.runtime);
 await Parser.init(); const language=await Language.load(d.grammar);
 const parser=new Parser(); parser.setLanguage(language);
 const tree=parser.parse(d.content);
 if(!tree)throw Error('Parser returned no syntax tree');
 const out={status:tree.rootNode.hasError?'PARSE_ERROR':'PARSED',truncated:false,declarations:[],imports:[],references:[],calls:[]};
 const declarationTypes=new Set(['function_definition','class_definition','class_declaration','method_declaration','constructor_declaration','struct_specifier','class_specifier']);
 const importTypes=new Set(['import_statement','import_from_statement','import_declaration','preproc_include']);
 const callTypes=new Set(['call','call_expression','method_invocation']);
 const field=(n,k)=>n.childForFieldName(k);
 function declarator(n){let a=field(n,'name')||field(n,'declarator'); for(let i=0;a&&i<12;i++){if(['identifier','field_identifier','type_identifier','qualified_identifier','operator_name','destructor_name'].includes(a.type))return a; a=field(a,'declarator')||field(a,'name');}return null;}
 function push(key,value,max){if(out[key].length<max)out[key].push(value);else out.truncated=true;}
 function walk(n,owner){
   let current=owner;
   if(declarationTypes.has(n.type)){
     const name=declarator(n);const body=field(n,'body');
     if(name){const isClass=/class|struct/.test(n.type);const kind=isClass?'CLASS':n.type==='method_declaration'||n.type==='constructor_declaration'||owner?'METHOD':'FUNCTION';
       push('declarations',{name:name.text,qualifier:owner||null,kind,startLine:n.startPosition.row+1,endLine:n.endPosition.row+1,bodyStartLine:(body||n).startPosition.row+1,implementation:!!body},1000);
       if(isClass)current=name.text;
     }
   }
   if(importTypes.has(n.type))push('imports',{text:n.text,startLine:n.startPosition.row+1,endLine:n.endPosition.row+1},1000);
   if(callTypes.has(n.type)){
     const target=field(n,'function')||field(n,'name');const name=target&&(field(target,'attribute')||field(target,'field')||field(target,'name')||target);
     const receiver=field(n,'object')||(target&&(field(target,'object')||field(target,'argument')));
     if(name)push('calls',{name:name.text.slice(0,256),receiver:receiver?receiver.text.slice(0,256):null,line:n.startPosition.row+1},1000);
   }
   if(['identifier','field_identifier','type_identifier'].includes(n.type))push('references',{name:n.text,line:n.startPosition.row+1},4000);
   for(const c of n.namedChildren)walk(c,current);
 }
 walk(tree.rootNode,null);tree.delete();parser.delete();parentPort.postMessage(out);
})().catch(e=>{throw e;});
`;

async function parsePrgSyntaxUnaccounted(
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<SyntaxFacts> {
  const language = staticSourceLanguage(path);
  if (!language || Buffer.byteLength(content) > 512 * 1024)
    throw new Error("Unsupported PRG syntax input or file exceeds 512 KiB");
  signal.throwIfAborted();
  const release = await acquireParser(signal);
  try {
    const runtime = createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm");
    const grammar = join(
      dirname(runtime),
      `tree-sitter-${language === "Python" ? "python" : language === "Java" ? "java" : "cpp"}.wasm`,
    );
    const worker = new Worker(script, {
      eval: true,
      execArgv: [],
      env: {},
      workerData: { runtime, grammar, content },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        void worker.terminate();
        if (error) reject(error);
        else {
          const parsed = SyntaxFactsSchema.safeParse(value);
          if (parsed.success) resolve(parsed.data);
          else reject(new Error("Invalid PRG parser output"));
        }
      };
      const abort = () => finish(signal.reason ?? new Error("PRG parsing cancelled"));
      const timer = setTimeout(() => finish(new Error("PRG parser deadline exceeded")), 8000);
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (value) => finish(undefined, value));
      worker.once("error", finish);
      worker.once("exit", (code) => {
        if (!settled) finish(new Error(`PRG parser exited without output: ${code}`));
      });
    });
  } finally {
    release();
  }
}

export async function parsePrgSyntax(
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<SyntaxFacts> {
  const runtime = resourceBudgetContext.getStore();
  const parse = () => parsePrgSyntaxUnaccounted(path, content, signal);
  return runtime
    ? runtime.internal("prg:parse", { toolExecutions: 1, timeMs: 8000 }, parse)
    : parse();
}

/** AST validates declarations and dependency locations. Existing manifest resolver supplies
 * navigation candidates only; dynamic binding/overload resolution is deliberately not claimed. */
export function sourceUnitFromSyntax(
  path: string,
  content: string,
  paths: readonly string[],
  syntax: SyntaxFacts,
): SourceUnit {
  const lexical = parseStaticSource(path, content, paths)!;
  const imports = lexical.dependencies
    .filter(
      (d) =>
        d.kind === "IMPORT" &&
        syntax.imports.some((i) => i.startLine <= d.line && i.endLine >= d.line),
    )
    .map((dependency) => {
      // A unique suffix match does not establish Python sys.path, Java classpath,
      // or C++ include-search/conditional configuration. Retain it as navigation.
      const declaration =
        syntax.imports.find((i) => i.startLine <= dependency.line && i.endLine >= dependency.line)
          ?.text ?? "";
      const explicitRelative =
        lexical.language === "Python" && dependency.specifier.startsWith(".");
      const localInclude =
        lexical.language === "C++" &&
        /^#\s*include\s*"/u.test(declaration.trim()) &&
        !/^\s*#\s*(?:if|ifdef|ifndef|define)\b/mu.test(content) &&
        dependency.paths[0] ===
          posix.normalize(posix.join(posix.dirname(path), dependency.specifier));
      return dependency.resolution === "RESOLVED" && !explicitRelative && !localInclude
        ? {
            ...dependency,
            resolution: "UNRESOLVED" as const,
            provenance: `${dependency.provenance}; import search configuration not verified`,
          }
        : dependency;
    });
  const implementationPairs = lexical.dependencies
    .filter((d) => d.kind === "IMPLEMENTATION_PAIR")
    .map((d) => ({
      ...d,
      resolution: "UNRESOLVED" as const,
      provenance: `${d.provenance}; filename pairing hypothesis, not an AST-proven target`,
    }));
  return {
    ...lexical,
    sha256: hash(content),
    parser: "TREE_SITTER_WASM",
    definitions: syntax.declarations.map((d) => ({
      ...d,
      forwarding: false,
      calls: syntax.calls.filter((c) => c.line >= d.bodyStartLine && c.line <= d.endLine),
    })),
    dependencies: syntax.status === "PARSED" ? [...imports, ...implementationPairs] : [],
    unknown: [
      ...lexical.unknown,
      "Syntax references/call sites do not prove resolved runtime targets.",
      ...(syntax.status === "PARSE_ERROR" ? ["Syntax errors; imports remain unverified."] : []),
      ...(syntax.truncated ? ["Syntax fact capacity exceeded."] : []),
    ],
  };
}
