import { sha256 } from "@devflow/eval";
import type { SandboxSession } from "@devflow/sandbox";
import type { ToolExecutionResult } from "@devflow/tools";
import { graphPathAllowed } from "../localization/relation-graph.js";
import type { ReplanFile } from "./replan-evidence.js";

/** Host observations for one Sandbox instance. Never serialize this cache across restore.
 * The owner must observe every mutation/command before it uses the next cached observation. */
export class CurrentSourceCache {
  private readonly sources = new Map<string, ReplanFile>();
  private readonly identities = new Map<string, string>();
  private readonly baselines = new Map<string, string | null>();
  private baseHead: string | undefined;
  private mutationEpoch = 0;

  constructor(private readonly sandbox: SandboxSession) {}

  get epoch() {
    return this.mutationEpoch;
  }
  matches(sandbox: SandboxSession) {
    return sandbox === this.sandbox;
  }
  head(sandbox: SandboxSession) {
    return this.matches(sandbox) ? this.baseHead : undefined;
  }
  rememberHead(sandbox: SandboxSession, head: string) {
    if (this.matches(sandbox) && /^[a-f0-9]{40,64}$/u.test(head)) this.baseHead = head;
  }

  source(sandbox: SandboxSession, path: string) {
    return this.matches(sandbox) ? this.sources.get(path) : undefined;
  }
  identity(sandbox: SandboxSession, path: string) {
    return this.matches(sandbox) ? this.identities.get(path) : undefined;
  }
  baseline(sandbox: SandboxSession, commit: string, path: string) {
    return this.matches(sandbox) ? this.baselines.get(`${commit}:${path}`) : undefined;
  }
  rememberBaseline(sandbox: SandboxSession, commit: string, path: string, content: string | null) {
    if (!this.matches(sandbox) || !graphPathAllowed(path)) return;
    this.baselines.set(`${commit}:${path}`, content);
  }
  remember(sandbox: SandboxSession, file: ReplanFile) {
    if (
      !this.matches(sandbox) ||
      !graphPathAllowed(file.path) ||
      !/^[a-f0-9]{64}$/u.test(file.contentHash) ||
      sha256(file.content) !== file.contentHash
    )
      return false;
    this.sources.set(file.path, { ...file, sizeBytes: Buffer.byteLength(file.content) });
    this.identities.set(file.path, file.contentHash);
    return true;
  }
  /** Only a physical full-file SHA observation or explicit NOT_FOUND may seed an identity. */
  rememberIdentity(sandbox: SandboxSession, path: string, identity: string) {
    if (
      !this.matches(sandbox) ||
      !graphPathAllowed(path) ||
      !/^(?:[a-f0-9]{64}|ABSENT)$/u.test(identity)
    )
      return;
    if (this.sources.get(path)?.contentHash !== identity) this.sources.delete(path);
    this.identities.set(path, identity);
  }
  invalidate(paths?: readonly string[]) {
    this.mutationEpoch++;
    if (!paths) {
      this.sources.clear();
      this.identities.clear();
      this.baseHead = undefined;
    } else
      for (const path of paths) {
        this.sources.delete(path);
        this.identities.delete(path);
      }
  }
  observe(name: string, result: ToolExecutionResult) {
    const mutation = result.mutation;
    if (name === "runCommand") this.invalidate();
    else if (mutation) {
      if (!mutation.observationComplete) this.invalidate();
      else if (mutation.workspaceChanged)
        this.invalidate(mutation.affectedPaths ?? mutation.changedFiles);
    } else if (["runCommand", "writeFile", "replaceText", "applyPatch"].includes(name)) {
      this.invalidate();
    }
    if (!result.ok || name !== "readFile") return;
    const file = result.output as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.fileSha256 !== "string") return;
    if (file.truncated === false && typeof file.content === "string") {
      this.remember(this.sandbox, {
        path: file.path,
        content: file.content,
        contentHash: file.fileSha256,
        sizeBytes: Buffer.byteLength(file.content),
      });
    } else this.rememberIdentity(this.sandbox, file.path, file.fileSha256);
  }
}
