import type { SandboxSession } from "@devflow/sandbox";
import type { IndexSource } from "../localization/contracts.js";
import { graphPathAllowed } from "../localization/relation-graph.js";

// One bounded host capture, rather than spending one Agent tool call per import.
// Parsing/transpilation happens on the host; no model code executes in this phase.
const CAPTURE = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{
 try{
 const input=JSON.parse(raw),root='/workspace',files={},pending=[input.entrypoint];let bytes=0;
 const safe=p=>!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').includes('..')&&!p.split('/').some(x=>x.startsWith('.')||/^(?:node_modules|hidden-acceptance|hidden-tests?|private|evaluator|evaluation|credentials)$/i.test(x))&&!/(?:secret|credential|\.env)/i.test(p);
 const base=input.baseCommit;
 if(base&&!/^[a-f0-9]{40,64}$/.test(base))throw Error('Invalid fixed Git revision');
 let tree;
 if(base){tree=new Set(cp.execFileSync('git',['ls-tree','-r','-z',base],{cwd:root,maxBuffer:8*1024*1024}).toString().split('\0').flatMap(row=>{const m=row.match(/^100\d+ blob [a-f0-9]+\t(.+)$/);return m?[m[1]]:[]}))}
 function exists(p){if(!safe(p)||!/\.(?:[cm]?[jt]sx?|json)$/.test(p))return false;if(tree)return tree.has(p);const target=path.join(root,p);try{return fs.lstatSync(target).isFile()&&fs.realpathSync(target)===target}catch{return false}}
 function enqueue(name,code){for(const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)["']([^"']+)["']/g)){if(!m[1].startsWith('.'))continue;const r=path.posix.normalize(path.posix.join(path.posix.dirname(name),m[1])),stem=r.replace(/\.(?:[cm]?js|[cm]?ts)$/,'');if(!safe(r))throw Error('Non-public import');const found=[r,stem+'.ts',stem+'.js',stem+'.cts',stem+'.cjs',r+'/index.ts',r+'/index.js'].find(exists);if(found&&!Object.hasOwn(files,found))pending.push(found)}}
 enqueue('__review_probe__.ts',input.probeCode);
 while(pending.length){const p=pending.shift();if(Object.hasOwn(files,p))continue;if(!exists(p))throw Error('Missing public entrypoint');if(Object.keys(files).length>=256)throw Error('Module capture limit');
 const content=base?cp.execFileSync('git',['show','--no-ext-diff','--no-textconv',base+':'+p],{cwd:root,maxBuffer:512*1024}):fs.readFileSync(path.join(root,p));
 bytes+=content.length;if(content.length>512*1024||bytes>6*1024*1024)throw Error('Source capture byte limit');files[p]=content.toString('utf8');enqueue(p,files[p]);}
 process.stdout.write(JSON.stringify(files));
 }catch(e){console.error(String(e));process.exitCode=1}
});`;

export async function capturePublicProbeSource(
  sandbox: SandboxSession,
  entrypoint: string,
  probeCode: string,
  signal: AbortSignal,
  baseCommit?: string,
): Promise<IndexSource> {
  if (!graphPathAllowed(entrypoint) || Buffer.byteLength(probeCode) > 16 * 1024)
    throw new Error("PROBE_POLICY_REJECTED");
  const result = await sandbox.exec(
    {
      program: "node",
      args: ["-e", CAPTURE],
      stdin: JSON.stringify({ entrypoint, probeCode, ...(baseCommit ? { baseCommit } : {}) }),
      timeoutMs: 30_000,
      maxOutputBytes: 10_000_000,
    },
    signal,
  );
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated)
    throw new Error(`PROBE_SOURCE_UNAVAILABLE: ${result.stderr.slice(0, 2000)}`);
  const files = JSON.parse(result.stdout) as Record<string, string>;
  for (const [name, content] of Object.entries(files))
    if (!graphPathAllowed(name) || typeof content !== "string")
      throw new Error("PROBE_POLICY_REJECTED");
  return {
    async manifest() {
      return {
        entries: Object.entries(files).map(([path, content]) => ({
          path,
          kind: "FILE" as const,
          sizeBytes: Buffer.byteLength(content),
        })),
        incomplete: false,
      };
    },
    async read(path) {
      if (!Object.hasOwn(files, path)) throw new Error("Probe source unavailable");
      return { content: files[path]!, truncated: false };
    },
  };
}
