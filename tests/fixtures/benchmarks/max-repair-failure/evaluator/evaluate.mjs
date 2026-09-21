import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const workspace = process.argv[2];
const { canDelete } = await import(pathToFileURL(path.join(workspace, "permission.mjs")));
assert.equal(canDelete({ id: "owner" }, { ownerId: "owner" }), true);
assert.equal(canDelete({ id: "guest" }, { ownerId: "owner" }), false);
assert.equal(canDelete(undefined, { ownerId: "owner" }), false);
console.log("evaluation passed");
