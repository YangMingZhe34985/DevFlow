import { describe, expect, it } from "vitest";

import { normalizeWorkspacePath } from "../src/aci/files.js";

describe("normalizeWorkspacePath", () => {
  it("maps the path forms models write onto workspace-relative paths", () => {
    expect(normalizeWorkspacePath("/workspace/src/a.ts")).toBe("src/a.ts");
    expect(normalizeWorkspacePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeWorkspacePath("././src/a.ts")).toBe("src/a.ts");
    expect(normalizeWorkspacePath(" src/a.ts ")).toBe("src/a.ts");
    expect(normalizeWorkspacePath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeWorkspacePath("/workspace")).toBe(".");
  });

  it("leaves scratch and out-of-workspace paths for the guard to judge", () => {
    expect(normalizeWorkspacePath("/tmp/repro.py")).toBe("/tmp/repro.py");
    expect(normalizeWorkspacePath("/etc/passwd")).toBe("/etc/passwd");
    expect(normalizeWorkspacePath("/workspacex/a")).toBe("/workspacex/a");
  });
});
