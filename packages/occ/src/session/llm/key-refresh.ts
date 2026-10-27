import fsNode from "fs/promises"
import { Effect } from "effect"
import { LLMKeyPool } from "./key-pool"
import { LLMRateLimit } from "./rate-limit"

// How often the credential sources are fingerprinted. A reload only happens
// when one of them actually changed, so the default can stay coarse.
export const DEFAULT_REFRESH_MS = 10 * 60 * 1000

export const intervalFromEnv = (raw: string | undefined): number => {
  if (!raw) return DEFAULT_REFRESH_MS
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REFRESH_MS
}

// Cheap change detector: mtime + size of every file that can seed a credential.
// Missing files are part of the fingerprint so creating one triggers a reload.
export const fingerprint = (files: readonly string[]): Effect.Effect<string> =>
  Effect.promise(async () => {
    const parts: string[] = []
    for (const file of files) {
      try {
        const stat = await fsNode.stat(file)
        parts.push(`${file}:${stat.mtimeMs}:${stat.size}`)
      } catch {
        parts.push(`${file}:missing`)
      }
    }
    return parts.join("|")
  })

export type WatchInput = {
  readonly providerID: string
  readonly intervalMs: number
  readonly files: () => readonly string[]
  readonly reload: () => Effect.Effect<void>
  readonly resolve: () => Effect.Effect<readonly string[]>
  readonly onChange: (change: LLMKeyPool.SyncResult) => Effect.Effect<void>
}

// Long-running reconciler intended for `Effect.forkScoped` inside a service
// scope. It never returns; interruption is the shutdown signal.
export const watch = (input: WatchInput): Effect.Effect<never> =>
  Effect.gen(function* () {
    let previous = yield* fingerprint(input.files())
    while (true) {
      yield* Effect.sleep(input.intervalMs)
      const next = yield* fingerprint(input.files())
      if (next === previous) continue
      previous = next
      yield* input.reload()
      const change = LLMKeyPool.sync(input.providerID, yield* input.resolve())
      if (change.changed) {
        LLMRateLimit.retain(input.providerID, change.keys)
        yield* input.onChange(change)
      }
    }
  }) as Effect.Effect<never>

export * as LLMKeyRefresh from "./key-refresh"
