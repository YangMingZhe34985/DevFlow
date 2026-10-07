import { describe, it, expect, vi } from "vitest";
import { sha256 } from "@devflow/eval";
import { DevflowError } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";
import { replanSource, replanOperationReserve } from "../src/runs/replan-source.js";
import { ReplanEvidenceReader } from "../src/runs/replan-evidence.js";

function fixture(complete = true) {
  const signal = new AbortController().signal;
  const readFile = vi.fn(async () => ({
    content: "def lookup_execution():\n    return None\n",
    truncated: false,
    fileSha256: sha256("def lookup_execution():\n    return None\n"),
  }));
  const listFiles = vi.fn(async () => {
    throw new DevflowError({ code: "NOT_FOUND", message: "missing" });
  });
  const sandbox = { readFile, listFiles } as unknown as SandboxSession;
  const reader = new ReplanEvidenceReader(sandbox, signal, async () => {});
  const beforeMetadata = vi.fn(async () => {});
  const source = replanSource({
    sandbox,
    reader,
    entries: [{ path: "a/b/c/registry.py", kind: "FILE", sizeBytes: 40 }],
    complete,
    revision: "r1",
    beforeMetadata,
  });
  return { signal, readFile, listFiles, sandbox, reader, source, beforeMetadata };
}
describe("versioned bounded replanning preparation", () => {
  it("uses the deep Python manifest without traversing directories and reads current identity once", async () => {
    const f = fixture();
    await f.source.manifest(f.signal);
    await f.source.lookup!("a/b/c", f.signal);
    const entry = await f.source.lookup!("a/b/c/registry.py", f.signal);
    await f.source.read("a/b/c/registry.py", f.signal);
    await f.source.lookup!("a/b/c/registry.py", f.signal);
    expect(entry?.contentHash).toHaveLength(64);
    expect(f.readFile).toHaveBeenCalledTimes(1);
    expect(f.listFiles).not.toHaveBeenCalled();
  });
  it("caches explicit missing package.json but keeps incomplete manifests visible", async () => {
    const f = fixture(false);
    expect((await f.source.manifest(f.signal)).incomplete).toBe(true);
    await f.source.lookup!("package.json", f.signal);
    await f.source.lookup!("package.json", f.signal);
    expect(f.listFiles).toHaveBeenCalledTimes(1);
  });
  it("does not turn access errors or truncated listings into absence", async () => {
    const f = fixture(false);
    f.listFiles.mockImplementation(async () => {
      throw Error("permission denied");
    });
    for (let n = 0; n < 2; n++)
      await expect(f.source.lookup!("unknown.py", f.signal)).rejects.toThrow("permission denied");
    expect(f.listFiles).toHaveBeenCalledTimes(2);
  });
  it("rejects forbidden paths without IO", async () => {
    const f = fixture();
    await expect(f.source.lookup!("../secret", f.signal)).rejects.toThrow();
    expect(f.listFiles).not.toHaveBeenCalled();
  });
  it("does not record a physical read after a failed preflight", async () => {
    const f = fixture();
    const reader = new ReplanEvidenceReader(f.sandbox, f.signal, async () => {
      throw Error("reserve insufficient");
    });
    await expect(reader.read("a.py")).rejects.toThrow("reserve insufficient");
    expect(reader.state.reads).toBe(0);
    expect(f.readFile).not.toHaveBeenCalled();
  });
  it("uses a fresh revision after restore instead of old source or negative cache", async () => {
    const f = fixture(false);
    await f.source.lookup!("missing.py", f.signal);
    const next = replanSource({
      sandbox: f.sandbox,
      reader: new ReplanEvidenceReader(f.sandbox, f.signal, async () => {}),
      entries: [],
      complete: false,
      revision: "r2",
      beforeMetadata: async () => {},
    });
    await next.lookup!("missing.py", f.signal);
    expect(f.listFiles).toHaveBeenCalledTimes(2);
  });
  it("reserves one shared read allowance and leaves capacity checks uncharged", () => {
    const reserve = replanOperationReserve(1, 4, true);
    expect(reserve.operations.sourceReads).toBe(8);
    expect(reserve.downstream).toBe(22);
    expect(reserve.total).toBe(37);
  });
});
