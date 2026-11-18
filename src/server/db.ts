import { redis } from "@devvit/web/server";
import { decodeState, type StateStore } from "./state.ts";

export const redisStore: StateStore = {
  async read(key) {
    return decodeState(await redis.get(key));
  },
  async update(key, change) {
    const transaction = await redis.watch(key);
    let queued = false;
    let finished = false;
    try {
      const current = decodeState(await redis.get(key));
      const result = change(current);
      if (!result.ok || result.state === current) {
        await transaction.unwatch();
        finished = true;
        return result;
      }
      await transaction.multi();
      queued = true;
      await transaction.set(key, JSON.stringify(result.state));
      const replies: unknown[] = await transaction.exec();
      finished = true;
      if (replies.length === 1 && replies[0] === "OK") return result;
      return { ok: false, state: decodeState(await redis.get(key)) };
    } finally {
      if (!finished) {
        const cleanup = queued ? transaction.discard() : transaction.unwatch();
        await cleanup.catch(() => console.warn("Could not release the save transaction."));
      }
    }
  },
};
