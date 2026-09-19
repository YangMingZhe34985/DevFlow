import { z } from "zod";

import { DevflowError } from "@devflow/shared";

export const IdSchema = z.string().uuid();

export function requiredRecord<T>(record: T | null, entity: string, id: string): T {
  if (record !== null) return record;
  throw new DevflowError({
    code: "NOT_FOUND",
    message: `${entity} '${id}' was not found.`,
  });
}
