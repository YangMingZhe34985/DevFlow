import assert from "node:assert/strict";

import { workForever } from "../worker.mjs";

assert.equal(typeof workForever, "function");
console.log("public tests passed");
