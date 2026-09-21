import assert from "node:assert/strict";
import { normalizeUsername } from "../solution.mjs";

assert.equal(normalizeUsername(" Alice "), "alice");
