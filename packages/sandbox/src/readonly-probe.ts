import { randomUUID } from "node:crypto";
import type { DockerCommandRunner } from "./docker-sandbox-manager.js";

export interface ReadonlyProbeInput {
  entrypoint: string;
  script: string;
  modules: Record<string, string>;
}
export interface ReadonlyProbeExecution {
  status: "COMPLETED" | "TIMEOUT" | "DEPENDENCY_MISSING" | "UNAVAILABLE";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
  behaviorOutcome?:
    "EXPECTATION_MET" | "EXPECTATION_FAILED" | "SCRIPT_ERROR" | "NO_ASSERTION" | undefined;
  assertions?: { ok: boolean; expected: string; actual: string }[] | undefined;
}

// Host-owned wrapper: public TS/JS is an immutable in-memory module overlay.
// It never writes into or executes inside the writable candidate sandbox.
const WRAPPER = String.raw`
const path = require('node:path');
const native = require('node:module').createRequire('/workspace/package.json');
let input=''; process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input+=c; if(Buffer.byteLength(input)>24*1024*1024) process.exit(87); });
process.stdin.on('end', () => {
  const assertions=[];
  let scriptError=false;
  try {
    const payload=JSON.parse(input), cache=new Map();
    const modules=Object.freeze(payload.modules);
    function load(id) {
      if(cache.has(id)) return cache.get(id).exports;
      const module={exports:{}}; cache.set(id,module);
      const localRequire=specifier => {
        if(!specifier.startsWith('.')) return native(specifier);
        const root=path.posix.normalize(path.posix.join(path.posix.dirname(id),specifier));
        const stem=root.replace(/\.(?:[cm]?js|[cm]?ts)$/, '');
        const found=[root,stem+'.ts',stem+'.js',stem+'.cts',stem+'.cjs',root+'/index.ts',root+'/index.js'].find(p=>Object.hasOwn(modules,p));
        if(!found) {const e=new Error('Public module unavailable: '+root);e.code='MODULE_NOT_FOUND';throw e;}
        return load(found);
      };
      if(id.endsWith('.json')) module.exports=JSON.parse(modules[id]);
      else new Function('require','module','exports','__filename','__dirname','entry','assertBehavior',modules[id])(
        localRequire,module,module.exports,'/workspace/'+id,'/workspace/'+path.posix.dirname(id),
        id==='__review_probe__.ts' ? load(payload.entrypoint) : undefined,
        id==='__review_probe__.ts' ? (ok,expected,actual)=>{
          if(typeof ok!=='boolean') throw Error('assertBehavior: ok must be boolean; example: assertBehavior(entry.value === 2, "value=2", String(entry.value))');
          if(typeof expected!=='string') throw Error('assertBehavior: expected must be string; use a description of the task requirement');
          if(typeof actual!=='string') throw Error('assertBehavior: actual must be string; example: assertBehavior(entry.value === 2, "value=2", String(entry.value))');
          if(assertions.length>=4) throw Error('assertBehavior: maximum four behavior assertions');
          assertions.push({ok,expected:expected.slice(0,2000),actual:actual.slice(0,2000)});
        } : undefined);
      return module.exports;
    }
    load('__review_probe__.ts');
  } catch(error) { scriptError=true;console.error(error.stack || String(error)); process.exitCode=error.code==='MODULE_NOT_FOUND' || error.code==='ERR_REQUIRE_ESM' ? 88 : 1; }
  const behaviorOutcome=scriptError?'SCRIPT_ERROR':!assertions.length?'NO_ASSERTION':assertions.some(a=>!a.ok)?'EXPECTATION_FAILED':'EXPECTATION_MET';
  if(behaviorOutcome==='EXPECTATION_FAILED')process.exitCode=1;
  console.log('@@DEVFLOW_BEHAVIOR@@'+JSON.stringify({behaviorOutcome,assertions}));
});`;

export class ReadonlyProbeRunner {
  constructor(private readonly runner: DockerCommandRunner) {}
  async imageIdentity(image: string, signal: AbortSignal): Promise<string> {
    const result = await this.runner.run(["image", "inspect", "--format", "{{.Id}}", image], {
      signal,
    });
    if (result.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(result.stdout.trim()))
      throw new Error("The configured, locally installed probe image is unavailable.");
    return result.stdout.trim();
  }
  async run(
    input: ReadonlyProbeInput,
    imageIdentity: string,
    signal: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<ReadonlyProbeExecution> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageIdentity))
      throw new Error("Pinned local image required.");
    const started = Date.now(),
      name = `devflow-review-probe-${randomUUID()}`;
    const deadline = AbortSignal.timeout(Math.min(30_000, Math.max(1, timeoutMs)));
    const bounded = AbortSignal.any([signal, deadline]);
    try {
      const created = await this.runner.run(
        [
          "create",
          "--name",
          name,
          "--label",
          "devflow.managed=true",
          "--label",
          "devflow.purpose=review-probe",
          "--interactive",
          "--init",
          "--read-only",
          "--network",
          "none",
          "--cpus",
          "1",
          "--memory",
          "512m",
          "--memory-swap",
          "512m",
          "--pids-limit",
          "64",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "10001:10001",
          "--workdir",
          "/scratch",
          "--tmpfs",
          "/scratch:rw,noexec,nosuid,size=32m,uid=10001,gid=10001,mode=700",
          "--entrypoint",
          "/usr/bin/env",
          imageIdentity,
          "-i",
          "PATH=/usr/local/bin:/usr/bin:/bin",
          "HOME=/scratch",
          "TMPDIR=/scratch",
          "node",
          "-e",
          WRAPPER,
        ],
        { signal: bounded },
      );
      if (created.exitCode !== 0)
        throw new Error(created.stderr || "Probe container creation failed");
      const result = await this.runner.run(["start", "--attach", "--interactive", name], {
        signal: bounded,
        stdin: JSON.stringify(input),
        maxOutputBytes: 32 * 1024,
      });
      const line = result.stdout.trimEnd().split("\n").at(-1);
      let behavior: Pick<ReadonlyProbeExecution, "behaviorOutcome" | "assertions"> = {};
      if (!result.outputTruncated && line?.startsWith("@@DEVFLOW_BEHAVIOR@@")) {
        try {
          const parsed = JSON.parse(line.slice("@@DEVFLOW_BEHAVIOR@@".length));
          if (
            ["EXPECTATION_MET", "EXPECTATION_FAILED", "SCRIPT_ERROR", "NO_ASSERTION"].includes(
              parsed.behaviorOutcome,
            ) &&
            Array.isArray(parsed.assertions) &&
            parsed.assertions.length <= 4 &&
            parsed.assertions.every(
              (a: { ok?: unknown; expected?: unknown; actual?: unknown }) =>
                typeof a.ok === "boolean" &&
                typeof a.expected === "string" &&
                a.expected.length <= 2000 &&
                typeof a.actual === "string" &&
                a.actual.length <= 2000,
            )
          )
            behavior = { behaviorOutcome: parsed.behaviorOutcome, assertions: parsed.assertions };
        } catch {
          /* Unstructured output never establishes behavior. */
        }
      }
      return {
        ...behavior,
        status: result.exitCode === 88 ? "DEPENDENCY_MISSING" : "COMPLETED",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        outputTruncated: result.outputTruncated,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return {
        status: deadline.aborted ? "TIMEOUT" : "UNAVAILABLE",
        exitCode: null,
        stdout: "",
        stderr: String(error),
        outputTruncated: false,
        durationMs: Date.now() - started,
      };
    } finally {
      await this.runner.run(["rm", "--force", name]).catch(() => undefined);
    }
  }
}
