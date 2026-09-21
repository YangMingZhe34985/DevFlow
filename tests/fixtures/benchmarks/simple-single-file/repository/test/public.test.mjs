import assert from "node:assert/strict";

import { add } from "../calculator.mjs";

assert.equal(add(2, 3), 5);
console.log("public tests passed");
