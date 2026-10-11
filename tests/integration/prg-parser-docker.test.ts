import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const enabled = process.env.DEVFLOW_DOCKER_INTEGRATION === "1";
describe.skipIf(!enabled)("pinned PRG grammar portability in isolated Docker", () => {
  it.each([
    ["python", "def run(value):\n    return value\n"],
    ["java", "class Example { int run(int value) { return value; } }"],
    ["cpp", "int run(int value) { return value; }"],
  ])(
    "loads %s using the exact packaged runtime and grammar",
    async (language, source) => {
      const parserRoot = dirname(
        createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm"),
      );
      const script = `const {Parser,Language}=require('/parser/tree-sitter.js');
      (async()=>{ await Parser.init(); const p=new Parser(); p.setLanguage(await Language.load('/parser/tree-sitter-'+process.argv[1]+'.wasm'));
      const t=p.parse(process.argv[2]); if(!t || t.rootNode.hasError) process.exitCode=1;
      else console.log(JSON.stringify({language:process.argv[1],tree:t.rootNode.toString()})); t?.delete();p.delete(); })().catch(e=>{console.error(e.message);process.exitCode=1;});`;
      const result = await execute(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--mount",
          `type=bind,source=${parserRoot},target=/parser,readonly`,
          "devflow-sandbox:local",
          "node",
          "-e",
          script,
          language,
          source,
        ],
        { timeout: 30000, windowsHide: true },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        language,
        tree: expect.stringContaining("return"),
      });
    },
    40000,
  );
});
