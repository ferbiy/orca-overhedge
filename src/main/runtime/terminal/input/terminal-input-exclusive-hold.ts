// Overhedge: a PTY whose input one main-side operation owns for a short sequence (the in-place
// Claude account restart). While held, every admission-checked writer (desktop keys, mobile, CLI
// `terminal send`, orchestration prompt delivery) is refused; the holder writes to the PTY directly.
const heldPtyIds = new Set<string>()

/** Takes the PTY's input; null when another operation already holds it. Call the result once to
 *  release. */
export function holdTerminalInputExclusively(ptyId: string): (() => void) | null {
  if (heldPtyIds.has(ptyId)) {
    return null
  }
  heldPtyIds.add(ptyId)
  let released = false
  return () => {
    if (!released) {
      released = true
      heldPtyIds.delete(ptyId)
    }
  }
}

export function isTerminalInputHeldExclusively(ptyId: string): boolean {
  return heldPtyIds.size > 0 && heldPtyIds.has(ptyId)
}
