import { runMini } from "./run"
import type { Argv } from "yargs"
import { cmd } from "./cmd"

export const MiniCommand = cmd({
  command: "mini [prompt..]",
  describe: "start the interactive mini chat (TUI)",
  builder: (yargs: Argv) =>
    yargs
      .positional("prompt", {
        describe: "initial prompt to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("model", {
        alias: ["m"],
        type: "string",
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("continue", {
        alias: ["c"],
        type: "boolean",
        describe: "continue the last session",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session before continuing (requires --continue or --session)",
      })
      .option("dir", {
        type: "string",
        describe: "directory to start occ in",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied",
      }),
  handler: async (args) => {
    const message = (args.message ?? []).join(" ").trim() || undefined
    await runMini({
      prompt: message,
      model: args.model as string | undefined,
      agent: args.agent as string | undefined,
      continue: args.continue as boolean | undefined,
      session: args.session as string | undefined,
      fork: args.fork as boolean | undefined,
      directory: args.dir as string | undefined,
      attach: undefined,
      password: undefined,
      username: undefined,
    })
  },
})
