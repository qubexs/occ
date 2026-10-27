import { beforeEach, describe, expect, test } from "bun:test"
import fsNode from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber } from "effect"
import { tmpdir } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { LLMKeyRefresh } from "../../src/session/llm/key-refresh"
import { LLMKeyPool } from "../../src/session/llm/key-pool"

const provider = "opencode"

beforeEach(() => {
  LLMKeyPool.clear()
})

describe("LLMKeyRefresh.intervalFromEnv", () => {
  test("defaults to ten minutes", () => {
    expect(LLMKeyRefresh.intervalFromEnv(undefined)).toBe(LLMKeyRefresh.DEFAULT_REFRESH_MS)
    expect(LLMKeyRefresh.intervalFromEnv("")).toBe(LLMKeyRefresh.DEFAULT_REFRESH_MS)
  })

  test("accepts a positive override", () => {
    expect(LLMKeyRefresh.intervalFromEnv("1500")).toBe(1500)
  })

  test("ignores invalid override values", () => {
    expect(LLMKeyRefresh.intervalFromEnv("0")).toBe(LLMKeyRefresh.DEFAULT_REFRESH_MS)
    expect(LLMKeyRefresh.intervalFromEnv("-5")).toBe(LLMKeyRefresh.DEFAULT_REFRESH_MS)
    expect(LLMKeyRefresh.intervalFromEnv("soon")).toBe(LLMKeyRefresh.DEFAULT_REFRESH_MS)
  })
})

describe("LLMKeyRefresh.fingerprint", () => {
  test("changes when a watched file changes size", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = path.join(dir, "auth.json")
        await Bun.write(file, "{}")
        return file
      },
    })

    const before = await Effect.runPromise(LLMKeyRefresh.fingerprint([tmp.extra]))
    await Bun.write(tmp.extra, '{"opencode":{"type":"api"}}')
    const after = await Effect.runPromise(LLMKeyRefresh.fingerprint([tmp.extra]))

    expect(before).not.toBe(after)
    expect(before).toContain(`${tmp.extra}:`)
  })

  test("records missing files so creating one is a change", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")

    const before = await Effect.runPromise(LLMKeyRefresh.fingerprint([file]))
    expect(before).toBe(`${file}:missing`)

    await fsNode.writeFile(file, "{}")
    const after = await Effect.runPromise(LLMKeyRefresh.fingerprint([file]))
    expect(after).not.toBe(before)
    expect(after).not.toContain("missing")
  })
})

describe("LLMKeyRefresh.watch", () => {
  test("reconciles the pool when a watched file changes", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = path.join(dir, "auth.json")
        await Bun.write(file, "{}")
        return file
      },
    })
    const file = tmp.extra

    LLMKeyPool.register(provider, ["key-a"])
    let keys: string[] = ["key-a"]
    let fileReads = 0
    const seen = Deferred.makeUnsafe<LLMKeyPool.SyncResult>()

    const fiber = Effect.runFork(
      LLMKeyRefresh.watch({
        providerID: provider,
        intervalMs: 10,
        files: () => {
          fileReads++
          return [file]
        },
        reload: () => Effect.void,
        resolve: () => Effect.succeed(keys),
        onChange: (change) => Deferred.succeed(seen, change).pipe(Effect.asVoid),
      }),
    )

    try {
      // Wait until the loop has taken its baseline fingerprint before mutating
      // the file, otherwise the write could be folded into the baseline.
      await Effect.runPromise(
        pollWithTimeout(
          Effect.sync(() => (fileReads > 0 ? true : undefined)),
          "watch never started",
        ),
      )

      keys = ["key-a", "key-b"]
      await Bun.write(file, '{"changed":true}')

      const change = await Effect.runPromise(
        awaitWithTimeout(Deferred.await(seen), "watch never observed the file change"),
      )
      expect(change.changed).toBe(true)
      expect(change.added).toEqual(["key-b"])
      expect(LLMKeyPool.has(provider)).toBe(true)
      expect(LLMKeyPool.size(provider)).toBe(2)
    } finally {
      Effect.runSync(Fiber.interrupt(fiber))
    }
  })
})
