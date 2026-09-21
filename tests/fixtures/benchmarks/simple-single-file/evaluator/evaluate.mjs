import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const workspace = process.argv[2];
const { add } = await import(pathToFileURL(path.join(workspace, "calculator.mjs")));
assert.equal(add(9, 4), 13);
assert.equal(add(-2, 5), 3);
console.log("evaluation passed");
