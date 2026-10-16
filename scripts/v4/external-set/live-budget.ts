import fs from "node:fs/promises";
import {
  runAttempts,
  type AttemptsInput,
  type AttemptsResult,
} from "../../../apps/worker/src/autonomous/attempts.js";

export interface LiveAuthorization {
  cases: string[];
  budgetMicros: number;
  perCaseMicros: number;
}
function micros(value: string | undefined, name: string): number {
  if (!value || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value))
    throw Error(`Explicit positive --${name} required`);
  const amount = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw Error(`Invalid --${name}`);
  return amount;
}
export function authorizeLive(args: {
  cases?: string | undefined;
  budgetCny?: string | undefined;
  perCaseCny?: string | undefined;
}): LiveAuthorization {
  if (!args.cases || !/^X[A-Z0-9]+(?:,X[A-Z0-9]+)*$/.test(args.cases))
    throw Error("Explicit --cases required");
  const cases = args.cases.split(",");
  if (new Set(cases).size !== cases.length) throw Error("Duplicate case in batch");
  const budgetMicros = micros(args.budgetCny, "budget-cny"),
    perCaseMicros = micros(args.perCaseCny, "per-case-cny");
  if (perCaseMicros > budgetMicros) throw Error("Per-case limit exceeds batch budget");
  return { cases, budgetMicros, perCaseMicros };
}

interface Reservation {
  caseId: string;
  reservedMicros: number;
  status: "RESERVED" | "SETTLED" | "UNKNOWN";
  actualMicros?: number;
}
/** Serial batch ledger. Reservations survive a crash; an experiment path is single-use. */
export class BatchBudget {
  private entries: Reservation[] = [];
  constructor(
    private file: string,
    readonly authorization: LiveAuthorization,
  ) {}
  private async persist(create = false) {
    const content = JSON.stringify(
      { version: 1, ...this.authorization, entries: this.entries },
      null,
      2,
    );
    if (create) {
      await fs.writeFile(this.file, content, { flag: "wx" });
      return;
    }
    // Replacement is atomic; the old RESERVED entry remains authoritative if a crash
    // occurs before rename. The caller never dispatches before persistence completes.
    const temporary = this.file + ".next";
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, this.file);
  }
  async initialize() {
    await this.persist(true);
  }
  async reserve(caseId: string): Promise<number | undefined> {
    if (!this.authorization.cases.includes(caseId) || this.entries.some((e) => e.caseId === caseId))
      throw Error("Unknown or repeated batch case");
    const occupied = this.entries.reduce(
      (sum, e) => sum + (e.status === "SETTLED" ? e.actualMicros! : e.reservedMicros),
      0,
    );
    if (this.authorization.budgetMicros - occupied < this.authorization.perCaseMicros)
      return undefined;
    this.entries.push({
      caseId,
      reservedMicros: this.authorization.perCaseMicros,
      status: "RESERVED",
    });
    await this.persist();
    return this.authorization.perCaseMicros;
  }
  async settle(caseId: string, actualMicros?: number) {
    const entry = this.entries.find((e) => e.caseId === caseId);
    if (!entry || entry.status !== "RESERVED") throw Error("Reservation not settleable");
    if (actualMicros === undefined) entry.status = "UNKNOWN";
    else {
      if (!Number.isSafeInteger(actualMicros) || actualMicros < 0)
        throw Error("Invalid actual spending");
      entry.status = "SETTLED";
      entry.actualMicros = actualMicros;
    }
    await this.persist();
    if (actualMicros !== undefined && actualMicros > entry.reservedMicros)
      throw Error("Kernel budget breach; stop batch");
  }
}
/** Used by CLI and Fake tests; hard cap is passed to the real Kernel, not just the wrapper. */
export async function runWithinBudget(
  input: AttemptsInput,
  maxCostMicros: number,
  run: (input: AttemptsInput) => Promise<AttemptsResult> = runAttempts,
): Promise<AttemptsResult> {
  if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros <= 0)
    throw Error("Invalid Kernel budget");
  if (input.limits.maxCostMicros !== undefined && input.limits.maxCostMicros < maxCostMicros)
    maxCostMicros = input.limits.maxCostMicros;
  return run({ ...input, limits: { ...input.limits, maxCostMicros } });
}
export function redact(value: unknown, environment: NodeJS.ProcessEnv): string {
  const secrets = Object.entries(environment)
    .filter(
      ([key, v]) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|REDIS_URL)$/i.test(key) && v && v.length >= 5,
    )
    .map(([, v]) => v!);
  return JSON.stringify(
    value,
    (_key, v: unknown) =>
      typeof v === "string"
        ? secrets.reduce((s, secret) => s.replaceAll(secret, "[REDACTED]"), v)
        : v,
    2,
  );
}
