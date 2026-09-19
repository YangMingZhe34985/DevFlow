import assert from "node:assert/strict";
import test from "node:test";

import { add, subtract } from "../src/calculator.js";

test("add returns the sum", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract returns the difference", () => {
  assert.equal(subtract(7, 4), 3);
});
