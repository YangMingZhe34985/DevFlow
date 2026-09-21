import assert from "node:assert/strict";

import { canDelete } from "../permission.mjs";

assert.equal(canDelete({ id: "owner" }, { ownerId: "owner" }), true);
assert.equal(canDelete({ id: "guest" }, { ownerId: "owner" }), false);
console.log("public tests passed");
