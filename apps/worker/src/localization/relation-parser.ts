import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { acquireParser } from "./parser.js";
import { workspacePackages } from "./workspace-packages.js";

export const RELATION_PARSER_VERSION = "typescript-5.9.3-relations-v1";
export const RelationParseSchema = z.object({
  status: z.enum(["PARSED", "PARSE_ERROR"]),
  symbols: z.array(
    z.object({
      name: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      offset: z.number(),
      exported: z.boolean(),
    }),
  ),
  exports: z.array(
    z.object({
      name: z.string(),
      local: z.string().nullable(),
      line: z.number(),
      specifier: z.string().nullable(),
    }),
  ),
  imports: z.array(
    z.object({
      specifier: z.string().nullable(),
      kind: z.enum(["IMPORT", "REEXPORT", "DYNAMIC_IMPORT", "REQUIRE"]),
      line: z.number(),
      resolvedPath: z.string().nullable(),
      resolution: z.enum(["RESOLVED", "EXTERNAL", "UNRESOLVED", "DYNAMIC"]),
      reason: z.string(),
    }),
  ),
  configurationErrors: z.array(z.string()),
  truncated: z.boolean(),
});
export type RelationParse = z.infer<typeof RelationParseSchema>;

// Compiler services see only the captured manifest and configuration, never the host filesystem.
// Repository code/configuration is parsed as data in a bounded worker with no environment secrets.
const script = String.raw`
const { parentPort, workerData: d } = require('node:worker_threads');
const ts = require(d.typescript), p = require('node:path').posix;
const root='/repo/', paths = new Set(d.paths.map(x => root+x)), config=d.configuration;
const directories=new Set(['/repo']);
for(const file of paths) { let dir=p.dirname(file); while(dir.startsWith('/repo')) {directories.add(dir); const parent=p.dirname(dir); if(parent===dir)break; dir=parent;} }
const packages=d.workspacePackages.map(pkg=>({name:pkg.name,dir:p.dirname(root+pkg.path)}));
const ambiguousPackages=new Set(packages.filter(pkg=>packages.filter(other=>other.name===pkg.name).length>1).map(pkg=>pkg.name));
for(let i=packages.length-1;i>=0;i--)if(ambiguousPackages.has(packages[i].name))packages.splice(i,1);
const canonical = file => {
  file=p.normalize(file);
  for(const pkg of packages) { const prefix=root+'node_modules/'+pkg.name; if(file===prefix||file.startsWith(prefix+'/')) return pkg.dir+file.slice(prefix.length); }
  return file;
};
const host={
  useCaseSensitiveFileNames:true,
  fileExists:f=>paths.has(canonical(f)),
  readFile:f=>config[canonical(f).slice(root.length)],
  directoryExists:f=>directories.has(canonical(f).replace(/\/$/,''))||packages.some(pkg=>(root+'node_modules/'+pkg.name+'/').startsWith(p.normalize(f).replace(/\/$/,'')+'/')),
  realpath:canonical,
  readDirectory:f=>[...paths].filter(x=>x.startsWith(canonical(f).replace(/\/$/,'')+'/')),
  getCurrentDirectory:()=>'/repo',
  trace:()=>{},
};
const configurationErrors=[...ambiguousPackages].map(name=>'Ambiguous workspace package identity: '+name);
let options={ allowJs:true, module:ts.ModuleKind.ESNext, moduleResolution:ts.ModuleResolutionKind.Bundler, target:ts.ScriptTarget.ESNext };
if(d.configPath) {
  const parsed=ts.readConfigFile(root+d.configPath,host.readFile);
  if(parsed.error) configurationErrors.push(ts.flattenDiagnosticMessageText(parsed.error.messageText,' '));
  else {
    const cfg=ts.parseJsonConfigFileContent(parsed.config,host,p.dirname(root+d.configPath),undefined,root+d.configPath);
    options={...options,...cfg.options,allowJs:true};
    for(const err of cfg.errors) if(err.code!==18003) configurationErrors.push(ts.flattenDiagnosticMessageText(err.messageText,' '));
  }
}
const file=root+d.path, source=ts.createSourceFile(file,d.content,ts.ScriptTarget.Latest,true);
const imports=[], symbols=[], exports=[]; let truncated=false;
let shadowedRequire=false;
function findShadow(node) {
  if(node.name&&ts.isIdentifier(node.name)&&node.name.text==='require'&&(ts.isVariableDeclaration(node)||ts.isFunctionDeclaration(node)||ts.isParameter(node)||ts.isImportSpecifier(node)||ts.isImportClause(node)||ts.isNamespaceImport(node))) shadowedRequire=true;
  ts.forEachChild(node,findShadow);
}
findShadow(source);
const line=n=>source.getLineAndCharacterOfPosition(n.getStart(source)).line+1;
function dependency(node,specifier,kind) {
  if(imports.length>=500) { truncated=true; return; }
  const row={specifier,kind,line:line(node),resolvedPath:null,resolution:'DYNAMIC',reason:'Nonliteral runtime expression; no static target'};
  if(specifier!==null) {
    if(kind==='REQUIRE'&&shadowedRequire) { row.resolution='DYNAMIC'; row.reason='A repository declaration shadows require; syntax is not a verified module dependency'; imports.push(row); return; }
    const resolved=ts.resolveModuleName(specifier,file,options,host,undefined,undefined,kind==='REQUIRE'?ts.ModuleKind.CommonJS:ts.ModuleKind.ESNext).resolvedModule;
    const target=resolved&&canonical(resolved.resolvedFileName);
    if(target&&target.startsWith(root)&&paths.has(target)) { row.resolvedPath=target.slice(root.length); row.resolution='RESOLVED'; row.reason='TypeScript module resolution against captured manifest'; }
    else { row.resolution=/^(?:\.|\/|#)/.test(specifier)||Object.keys(options.paths||{}).some(k=>new RegExp('^'+k.replace(/[.+?^$(){}|[\]\\]/g,'\\$&').replace('*','.*')+'$').test(specifier))?'UNRESOLVED':'EXTERNAL'; row.reason=configurationErrors.length?'Incomplete or invalid compiler configuration':'No repository target found (external dependencies are not traversed)'; }
  }
  imports.push(row);
}
function visit(node) {
  if(node.name && (ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isVariableDeclaration(node)||ts.isMethodDeclaration(node))) {
    if(symbols.length<1000) {
      let decl=ts.isVariableDeclaration(node)?node.parent.parent:node;
      const mods=ts.canHaveModifiers(decl)?ts.getModifiers(decl)||[]:[];
      const exported=mods.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
      const name=node.name.getText(source).slice(0,256);
      symbols.push({name,startLine:line(node),endLine:source.getLineAndCharacterOfPosition(node.getEnd()).line+1,offset:node.getStart(source),exported});
      if(exported&&ts.isIdentifier(node.name)) exports.push({name:mods.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword)?'default':name,local:name,line:line(node),specifier:null});
      if(exported&&(ts.isObjectBindingPattern(node.name)||ts.isArrayBindingPattern(node.name))) {
        const binding=b=>{if(ts.isIdentifier(b))exports.push({name:b.text,local:b.text,line:line(b),specifier:null});else for(const el of b.elements||[])if(ts.isBindingElement(el))binding(el.name);};binding(node.name);
      }
    } else truncated=true;
  }
  if((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))&&!node.name&&(ts.getModifiers(node)||[]).some(m=>m.kind===ts.SyntaxKind.DefaultKeyword))exports.push({name:'default',local:null,line:line(node),specifier:null});
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependency(node,node.moduleSpecifier.text,ts.isImportDeclaration(node)?'IMPORT':'REEXPORT');
  if(ts.isExportDeclaration(node)) {
    const specifier=node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)?node.moduleSpecifier.text:null;
    if(!node.exportClause) exports.push({name:'*',local:null,line:line(node),specifier});
    else if(ts.isNamedExports(node.exportClause)) for(const el of node.exportClause.elements) exports.push({name:el.name.text,local:(el.propertyName||el.name).text,line:line(el),specifier});
    else if(ts.isNamespaceExport(node.exportClause)) exports.push({name:node.exportClause.name.text,local:'*',line:line(node),specifier});
  }
  if(ts.isExportAssignment(node)) exports.push({name:node.isExportEquals?'export=':'default',local:ts.isIdentifier(node.expression)?node.expression.text:null,line:line(node),specifier:null});
  if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)) dependency(node, node.moduleReference.expression&&ts.isStringLiteral(node.moduleReference.expression)?node.moduleReference.expression.text:null,'REQUIRE');
  if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression)&&node.expression.text==='require')) dependency(node,node.arguments.length===1&&ts.isStringLiteral(node.arguments[0])?node.arguments[0].text:null,node.expression.kind===ts.SyntaxKind.ImportKeyword?'DYNAMIC_IMPORT':'REQUIRE');
  ts.forEachChild(node,visit);
}
visit(source);
parentPort.postMessage({status:source.parseDiagnostics.length?'PARSE_ERROR':'PARSED',symbols,exports:exports.slice(0,1000),imports,configurationErrors,truncated:truncated||exports.length>1000});
`;

export async function parseRelations(
  input: Parameters<typeof parseRelationsInWorker>[0],
  signal: AbortSignal,
): Promise<RelationParse> {
  const release = await acquireParser(signal);
  try {
    return await parseRelationsInWorker(input, signal);
  } finally {
    release();
  }
}
async function parseRelationsInWorker(
  input: {
    path: string;
    content: string;
    paths: string[];
    configuration: Record<string, string>;
    configPath?: string;
  },
  signal: AbortSignal,
): Promise<RelationParse> {
  signal.throwIfAborted();
  if (Buffer.byteLength(input.content) > 512 * 1024)
    throw new Error("Relation parser input exceeds 512 KiB");
  const worker = new Worker(script, {
    eval: true,
    env: {},
    workerData: {
      ...input,
      workspacePackages: workspacePackages(input.configuration),
      typescript: createRequire(import.meta.url).resolve("typescript"),
    },
    resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else {
        const parsed = RelationParseSchema.safeParse(result);
        if (parsed.success) resolve(parsed.data);
        else reject(new Error("Invalid relation parser result"));
      }
    };
    const abort = () => finish(signal.reason ?? new Error("Relation parsing cancelled"));
    const timer = setTimeout(() => finish(new Error("Relation parser deadline exceeded")), 8000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value) => finish(undefined, value));
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`Relation parser exited: ${code}`));
    });
  });
}
