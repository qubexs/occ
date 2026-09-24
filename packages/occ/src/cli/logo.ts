export * from "@opencode-ai/tui/logo"
import { go as tuiGo } from "@opencode-ai/tui/logo"

// occ splash mark: a big block "O" drawn with foreground-only cells
// (█ and plain space) so it renders identically on terminals with or
// without background-color support. The cell renderer maps "_" and "^"
// to background-colored blocks, which collapse to gaps elsewhere.
export const go = {
  left: tuiGo.left,
  right: ["      ", " ████ ", "██  ██", "██  ██", " ████ "],
}
