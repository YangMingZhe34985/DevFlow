/** Agent work may overlap, but hidden scoring shares one process-wide resource slot. */
let tail = Promise.resolve();
export async function serialScore<T>(evaluate: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await evaluate();
  } finally {
    release();
  }
}
