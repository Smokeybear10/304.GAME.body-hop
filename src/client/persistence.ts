import { z } from "zod";
import { CONTENT_VERSION, createChallenge } from "../shared/content.ts";
import {
  ChallengeSchema, CheckpointSchema, RunResultSchema,
  type Checkpoint, type RunResult,
} from "../shared/types.ts";

const ActiveSchema = z.object({ runId: z.uuid(), checkpoint: CheckpointSchema }).strict();
const StateSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeRun: ActiveSchema.nullable(),
  latestResult: RunResultSchema.nullable(),
  bestProgress: z.number().int().min(0).max(6),
  lastFinishedAt: z.iso.datetime().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.activeRun && value.activeRun.runId !== value.activeRun.checkpoint.runId)
    ctx.addIssue({ code: "custom", message: "Saved run identity disagrees." });
  if (value.activeRun && value.activeRun.runId === value.latestResult?.runId)
    ctx.addIssue({ code: "custom", message: "A finished run cannot be active." });
  if (value.bestProgress < Math.max(value.activeRun?.checkpoint.completedEncounters ?? 0, value.latestResult?.completedEncounters ?? 0))
    ctx.addIssue({ code: "custom", message: "Saved progress disagrees." });
});
const BootstrapSchema = z.object({
  mode: z.enum(["reddit", "local"]),
  challenge: ChallengeSchema.refine((value) =>
    z.iso.date().safeParse(value.date).success &&
    value.contentVersion === CONTENT_VERSION &&
    value.id === createChallenge(value.date).id,
  ),
  user: z.object({ id: z.string().min(1).max(120), username: z.string().nullable() }).strict().nullable(),
  state: StateSchema,
}).strict().superRefine((value, ctx) => {
  for (const data of [value.state.activeRun?.checkpoint, value.state.latestResult]) {
    if (data && (data.challengeId !== value.challenge.id || data.contentVersion !== value.challenge.contentVersion))
      ctx.addIssue({ code: "custom", message: "Saved data belongs to a different challenge." });
  }
});
const SaveEntrySchema = z.object({ kind: z.literal("save"), runId: z.uuid(), checkpoint: CheckpointSchema }).strict();
const ResultEntrySchema = z.object({ kind: z.literal("result"), runId: z.uuid(), result: RunResultSchema }).strict();
const EntrySchema = z.discriminatedUnion("kind", [SaveEntrySchema, ResultEntrySchema]);
const MutationSchema = z.discriminatedUnion("kind", [
  SaveEntrySchema.extend({ revision: z.number().int().nonnegative(), mutationId: z.uuid() }),
  ResultEntrySchema.extend({ revision: z.number().int().nonnegative(), mutationId: z.uuid() }),
]);
const CacheSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  active: ActiveSchema.nullable(),
  latestResult: RunResultSchema.nullable(),
  bestProgress: z.number().int().min(0).max(6),
  dirty: z.boolean(),
  pending: z.array(EntrySchema),
  inFlight: MutationSchema.nullable(),
}).strict();

type Entry = z.infer<typeof EntrySchema>;
type Mutation = z.infer<typeof MutationSchema>;
type Cache = z.infer<typeof CacheSchema>;
export type ActiveRun = z.infer<typeof ActiveSchema>;
export type Bootstrap = z.infer<typeof BootstrapSchema>;
export type SaveStatus = "saved" | "saving" | "local" | "offline" | "conflict" | "unavailable";
const DEADLINE = 10_000;
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function apiUrl(path: string, date?: string): string {
  return date ? `${path}?date=${encodeURIComponent(date)}` : path;
}

async function fetchBootstrap(date?: string): Promise<Bootstrap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE);
  try {
    const response = await fetch(apiUrl("/api/bootstrap", date), { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("The saved run could not be loaded. Try again.");
    return BootstrapSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("Loading this challenge timed out. Try again.");
    throw new Error("The saved challenge could not be loaded. Try again.");
  } finally {
    clearTimeout(timer);
  }
}

export class ProgressStore {
  readonly bootstrap: Bootstrap;
  active: ActiveRun | null;
  latestResult: RunResult | null;
  bestProgress: number;
  status: SaveStatus;
  error: string | null = null;
  onChange = () => {};
  private revision: number;
  private pending: Entry[] = [];
  private inFlight: Mutation | null = null;
  private saving = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private changeVersion = 0;
  private storageAvailable = true;
  private cacheBlocked = false;
  private cacheValue: string | null = null;
  private readonly key: string;

  private constructor(bootstrap: Bootstrap) {
    this.bootstrap = bootstrap;
    this.revision = bootstrap.state.revision;
    this.active = bootstrap.state.activeRun;
    this.latestResult = bootstrap.state.latestResult;
    this.bestProgress = bootstrap.state.bestProgress;
    this.status = bootstrap.user ? "saved" : "local";
    this.key = `bodyhop:run:${bootstrap.user?.id ?? "guest"}:${bootstrap.challenge.id}`;
    const cached = this.readCache(true);
    if (!cached) {
      if (!this.storageAvailable && !bootstrap.user) {
        this.status = "unavailable";
        this.error = "This browser cannot store a checkpoint. Keep this tab open to preserve your run.";
      }
      return;
    }
    if (!bootstrap.user) {
      this.active = cached.active;
      this.latestResult = cached.latestResult;
      this.bestProgress = cached.bestProgress;
      return;
    }
    if (cached.inFlight || (cached.dirty && cached.revision === this.revision)) {
      this.revision = cached.revision;
      this.active = cached.active;
      this.latestResult = cached.latestResult;
      this.bestProgress = Math.max(this.bestProgress, cached.bestProgress);
      this.inFlight = cached.inFlight;
      this.pending = cached.pending;
      this.status = "offline";
    } else if (cached.dirty) {
      this.clearCache();
      this.status = "conflict";
      this.error = "A newer save exists. Reload to use the saved checkpoint.";
    }
  }

  static async open(options: { date?: string } = {}): Promise<ProgressStore> {
    const store = new ProgressStore(await fetchBootstrap(options.date));
    void store.flush();
    return store;
  }

  save(runId: string, checkpoint: Checkpoint): void {
    if (this.status === "conflict" || this.latestResult?.runId === runId) return;
    const entry = SaveEntrySchema.parse({ kind: "save", runId, checkpoint });
    this.checkIdentity(entry);
    this.changeVersion++;
    this.active = { runId, checkpoint: structuredClone(entry.checkpoint) };
    this.bestProgress = Math.max(this.bestProgress, checkpoint.completedEncounters);
    this.enqueue(entry);
  }

  finish(runId: string, result: RunResult): void {
    if (this.status === "conflict" || this.latestResult?.runId === runId) return;
    const entry = ResultEntrySchema.parse({ kind: "result", runId, result });
    this.checkIdentity(entry);
    this.changeVersion++;
    this.active = null;
    this.latestResult = structuredClone(entry.result);
    this.bestProgress = Math.max(this.bestProgress, result.completedEncounters);
    this.enqueue(entry);
  }

  async refresh(): Promise<boolean> {
    if (!this.canRefresh() || !this.bootstrap.user) return false;
    const revision = this.revision;
    const changeVersion = this.changeVersion;
    let canonical: Bootstrap;
    try {
      canonical = await fetchBootstrap(this.localDate());
    } catch {
      return false;
    }
    if (
      !this.canRefresh() || this.revision !== revision || this.changeVersion !== changeVersion ||
      canonical.mode !== this.bootstrap.mode || canonical.user?.id !== this.bootstrap.user.id ||
      !same(canonical.challenge, this.bootstrap.challenge) || canonical.state.revision < revision
    ) return false;
    const cached = this.readCache();
    if (cached?.dirty || cached?.inFlight || cached?.pending.length) return false;
    this.bootstrap.state = canonical.state;
    this.revision = canonical.state.revision;
    this.active = canonical.state.activeRun;
    this.latestResult = canonical.state.latestResult;
    this.bestProgress = canonical.state.bestProgress;
    this.changeVersion++;
    this.error = null;
    this.persistCache();
    this.setStatus("saved");
    return true;
  }

  async flush(retrying = false): Promise<void> {
    if (this.saving || (!this.inFlight && !this.pending.length) || !this.bootstrap.user || this.status === "conflict") return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!retrying) this.retryAttempt = 0;
    this.saving = true;
    this.error = null;
    this.setStatus("saving");
    while (this.inFlight || this.pending.length) {
      if (!this.inFlight) {
        this.inFlight = { ...this.pending.shift()!, revision: this.revision, mutationId: crypto.randomUUID() };
        this.persistCache();
      }
      const item = this.inFlight;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEADLINE);
      try {
        const { kind, ...mutation } = item;
        const response = await fetch(apiUrl(kind === "save" ? "/api/save" : "/api/result", this.localDate()), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          signal: controller.signal,
          body: JSON.stringify({ challengeId: this.bootstrap.challenge.id, ...mutation }),
        });
        if (response.status === 409) {
          this.inFlight = null;
          this.pending = [];
          this.clearCache();
          this.saving = false;
          this.error = "A newer save exists. Reload to use the saved checkpoint.";
          this.setStatus("conflict");
          return;
        }
        if ([400, 401, 413, 415].includes(response.status)) {
          this.saving = false;
          this.error = "This run could not sync. Local play can continue; reload to recover the last saved checkpoint.";
          this.setStatus("unavailable");
          return;
        }
        if (!response.ok) throw new Error("Save unavailable.");
        const saved = z.object({ revision: z.number().int().nonnegative(), state: StateSchema }).parse(await response.json());
        if (saved.revision !== saved.state.revision || saved.revision < this.revision)
          throw new Error("The save acknowledgment could not be validated.");
        this.bootstrap.state = saved.state;
        this.revision = saved.revision;
        this.bestProgress = Math.max(this.bestProgress, saved.state.bestProgress);
        this.inFlight = null;
        this.retryAttempt = 0;
        const queuedResult = this.pending.findLast((entry) => entry.kind === "result");
        this.latestResult = queuedResult?.kind === "result" ? queuedResult.result : saved.state.latestResult;
        this.persistCache();
      } catch {
        this.saving = false;
        this.error = this.cacheBlocked
          ? "Another window has pending progress. Keep this view open until account sync finishes."
          : this.storageAvailable
          ? "Saved on this device. Account sync will retry."
          : "Sync is unavailable and this browser could not store a checkpoint. Keep this tab open.";
        this.setStatus(this.storageAvailable ? "offline" : "unavailable");
        this.scheduleRetry();
        return;
      } finally {
        clearTimeout(timer);
      }
    }
    this.saving = false;
    this.error = null;
    this.setStatus("saved");
  }

  private enqueue(entry: Entry): void {
    if (!this.bootstrap.user) {
      this.persistCache();
      this.error = this.storageAvailable ? null : "This browser could not store a checkpoint. Keep this tab open to preserve your run.";
      this.setStatus(this.storageAvailable ? "local" : "unavailable");
      return;
    }
    const copy = structuredClone(entry);
    const tail = this.pending.at(-1);
    if (tail?.kind === "save" && entry.kind === "save" && tail.runId === entry.runId)
      this.pending[this.pending.length - 1] = copy;
    else {
      const newest = tail ?? this.inFlight;
      if (!newest || !same(this.entryOf(newest), entry)) this.pending.push(copy);
    }
    this.persistCache();
    if (!this.retryTimer) void this.flush();
    else this.onChange();
  }

  private entryOf(value: Entry | Mutation): Entry {
    return value.kind === "save"
      ? { kind: "save", runId: value.runId, checkpoint: value.checkpoint }
      : { kind: "result", runId: value.runId, result: value.result };
  }

  private checkIdentity(entry: Entry): void {
    const data = entry.kind === "save" ? entry.checkpoint : entry.result;
    if (data.runId !== entry.runId || data.challengeId !== this.bootstrap.challenge.id || data.contentVersion !== this.bootstrap.challenge.contentVersion)
      throw new Error("This checkpoint belongs to a different run or challenge.");
  }

  private localDate(): string | undefined {
    return this.bootstrap.mode === "local" ? this.bootstrap.challenge.date : undefined;
  }

  private canRefresh(): boolean {
    return !this.saving && !this.inFlight && !this.pending.length && this.status !== "conflict";
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS[this.retryAttempt];
    if (delay === undefined || this.status === "conflict") return;
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush(true);
    }, delay);
  }

  private readCache(claim = false): Cache | null {
    try {
      const value = localStorage.getItem(this.key);
      if (claim) this.cacheValue = value;
      if (!value) return null;
      const parsed = CacheSchema.safeParse(JSON.parse(value));
      if (!parsed.success) return null;
      const cached = parsed.data;
      const entries: Entry[] = [...cached.pending];
      if (cached.inFlight) entries.push(this.entryOf(cached.inFlight));
      if (cached.active) entries.push({ kind: "save", ...cached.active });
      if (cached.latestResult) entries.push({ kind: "result", runId: cached.latestResult.runId, result: cached.latestResult });
      for (const entry of entries) this.checkIdentity(entry);
      return cached;
    } catch {
      this.storageAvailable = false;
      return null;
    }
  }

  private persistCache(): void {
    try {
      const existing = localStorage.getItem(this.key);
      if (existing && existing !== this.cacheValue) {
        const other = CacheSchema.safeParse(JSON.parse(existing));
        if (other.success && other.data.dirty) {
          this.cacheBlocked = true;
          this.storageAvailable = false;
          return;
        }
      }
      const value = JSON.stringify({
        schemaVersion: 1,
        revision: this.revision,
        active: this.active,
        latestResult: this.latestResult,
        bestProgress: this.bestProgress,
        dirty: this.inFlight !== null || this.pending.length > 0,
        pending: this.pending,
        inFlight: this.inFlight,
      } satisfies Cache);
      localStorage.setItem(this.key, value);
      this.cacheValue = value;
      this.cacheBlocked = false;
      this.storageAvailable = true;
    } catch {
      this.storageAvailable = false;
    }
  }

  private clearCache(): void {
    try {
      if (localStorage.getItem(this.key) === this.cacheValue) localStorage.removeItem(this.key);
      this.cacheValue = null;
    } catch {
      this.storageAvailable = false;
    }
  }

  private setStatus(status: SaveStatus): void {
    this.status = status;
    this.onChange();
  }
}
