import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const workspace = process.argv[2];
const { normalizeUsername } = await import(pathToFileURL(path.join(workspace, "solution.mjs")));
assert.equal(normalizeUsername(" Alice "), "alice");
assert.equal(normalizeUsername("BOB"), "bob");
assert.equal(normalizeUsername("  carol  "), "carol");
console.log("evaluation passed");
