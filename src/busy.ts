// Long jobs a page reload would cut short (AI review, proofreading, share link upload, ZIP and share-sheet exports).
// The background update waits while any of them runs.
let running = 0;

/** Marks a job as running; call the returned function (once is enough) when it ends. */
export function startBusy(): () => void {
  running++;
  let on = true;
  return () => { if (on) { on = false; running--; } };
}

/** Runs `job` marked as busy until it settles. */
export async function busy<T>(job: () => Promise<T>): Promise<T> {
  const end = startBusy();
  try { return await job(); } finally { end(); }
}

export const isBusy = (): boolean => running > 0;
