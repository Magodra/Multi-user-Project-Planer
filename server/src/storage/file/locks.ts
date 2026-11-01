import { open, rm, stat } from "node:fs/promises";

/** In-process FIFO mutex. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<R>(fn: () => Promise<R>): Promise<R> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const STALE_LOCK_MS = 30_000;
const RETRY_MS = 25;
const MAX_WAIT_MS = 15_000;

/**
 * Cross-process lock based on exclusive creation of a lock file.
 * A lock older than STALE_LOCK_MS is treated as left behind by a crashed process.
 */
export async function withLockFile<R>(lockPath: string, fn: () => Promise<R>): Promise<R> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for lock ${lockPath}`, { cause: err });
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
