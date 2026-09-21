import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const workspace = process.argv[2];
const { invoiceTotal } = await import(pathToFileURL(path.join(workspace, "src", "invoice.mjs")));
assert.equal(invoiceTotal([{ price: 10, quantity: 2 }]), 24);
assert.equal(
  invoiceTotal([
    { price: 5, quantity: 2 },
    { price: 10, quantity: 1 },
  ]),
  24,
);
console.log("evaluation passed");
