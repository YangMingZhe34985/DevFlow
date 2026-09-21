import assert from "node:assert/strict";

import { invoiceTotal } from "../src/invoice.mjs";

assert.equal(invoiceTotal([{ price: 10, quantity: 2 }]), 24);
console.log("public tests passed");
