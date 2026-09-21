import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const workspace = process.argv[2];
const { parsePort } = await import(pathToFileURL(path.join(workspace, "port.mjs")));
assert.equal(parsePort("3000"), 3000);
assert.throws(() => parsePort("not-a-port"), /port/iu);
assert.throws(() => parsePort("70000"), /port/iu);
console.log("evaluation passed");
