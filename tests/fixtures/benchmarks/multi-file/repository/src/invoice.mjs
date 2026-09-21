import { taxFor } from "./tax.mjs";

export function invoiceTotal(lines) {
  const subtotal = lines.reduce((total, line) => total + line.price * line.quantity, 0);
  return subtotal - taxFor(subtotal);
}
