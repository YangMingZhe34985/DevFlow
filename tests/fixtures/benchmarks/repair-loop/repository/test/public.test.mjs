import assert from "node:assert/strict";

import { parsePort } from "../port.mjs";

assert.equal(parsePort("3000"), 3000);
assert.throws(() => parsePort("not-a-port"), /port/iu);
console.log("public tests passed");
