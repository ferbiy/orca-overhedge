// Overhedge: positive screen evidence that a terminal Claude sits at its empty prompt. Anything this
// cannot recognise (a draft, a picker, a dialog, a question, vim NORMAL mode, background work, an
// unknown layout) is NOT proof, and the restart then types nothing.

export type ClaudePromptScreenProof =
  | { ok: true }
  | { ok: false; reason: string }

// The input box is drawn between two horizontal rules (newer Claude Code) or inside a rounded box.
// Why String.raw: the orcad bundle must stay ASCII, and the formatter unescapes regex literals.
// Box drawing: \u256D/\u2570 corners, \u2500 rule, \u256E/\u256F corners, \u2502 side.
const RULE_RE = new RegExp(String.raw`^\s*[\u256D\u2570]?\u2500{8,}[\u256E\u256F]?\s*$`)
// `>` or U+276F prompt marker, optionally inside box borders; group 1 is what follows the marker
// (after a space or a no-break space).
const PROMPT_RE = new RegExp(
  String.raw`^\s*\u2502?\s*(?:>|\u276F)(?:[ \u00A0](.*?))?\s*\u2502?\s*$`
)
// Lines that mean something other than a plain idle prompt is on screen.
const BLOCKING_PATTERNS: readonly [RegExp, string][] = [
  [
    new RegExp(
      String.raw`Enter to (?:select|confirm|submit)|Esc to (?:cancel|go back|exit)|\u2191/\u2193|\(y/n\)`,
      'i'
    ),
    'a menu or dialog is open'
  ],
  [new RegExp(String.raw`^\s*\u276F\s*\d+\.\s|^\s+\d+\.\s`), 'a choice list is open'],
  // Case-sensitive on purpose: the footer `bypass permissions on` is a mode, not a question.
  [/Do you want|Would you like|\bAllow\b|\bApprove\b|\?\s*$/, 'Claude is asking a question or for a permission'],
  [/ready to code\?|proceed\?/i, 'a plan approval may be open'],
  [/background|shells? running|bash(?:es)? running|agents? running|tasks? running|\d+\s+(?:shell|task|agent)s?\b/i, 'background shells, tasks or agents may be running'],
  [/-- NORMAL --|-- VISUAL --/, 'Claude input is in vim NORMAL/VISUAL mode'],
  [/esc to interrupt|interrupt/i, 'Claude is working'],
  [/exit anyway|really exit|press ctrl-c again|press ctrl-d again/i, 'an exit confirmation is showing'],
  [/search:|reverse-i-search|history search/i, 'a history search is open']
]
const NO_BREAK_SPACE_RE = new RegExp(String.raw`\u00A0`, 'g')
const REGION_LINES = 24
// Claude's spinner line sits just above the input box while a turn runs.
const WORKING_ABOVE_RE = /esc to interrupt/i
const WORKING_ABOVE_LINES = 4

type InputBox = { region: string[]; index: number }

/** The bottom of the screen as Claude's input box: exactly one prompt line between two rules. */
function findInputBox(lines: readonly string[], maxFooterLines = 4): InputBox | null {
  const region = lines
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .slice(-REGION_LINES)
  const prompts = region.flatMap((line, index) => (PROMPT_RE.test(line) ? [index] : []))
  if (prompts.length !== 1) {
    return null
  }
  const index = prompts[0]
  if (!RULE_RE.test(region[index - 1] ?? '') || !RULE_RE.test(region[index + 1] ?? '')) {
    return null
  }
  // At most a short footer below the box; more means something else is painted there.
  if (region.length - (index + 2) > maxFooterLines) {
    return null
  }
  return { region, index }
}

/** What the prompt line shows after its marker; null when Claude's input box is not recognised. */
export function claudePromptLineText(
  lines: readonly string[],
  maxFooterLines = 4
): string | null {
  const box = findInputBox(lines, maxFooterLines)
  if (!box) {
    return null
  }
  return (PROMPT_RE.exec(box.region[box.index])?.[1] ?? '').replace(NO_BREAK_SPACE_RE, ' ').trim()
}

/** Proof that Claude's input box is empty and nothing else (dialog, picker, question, background
 *  work, a running turn) is showing around it. */
export function proveClaudeEmptyPrompt(
  screen: { lines: readonly string[]; draft?: string } | null
): ClaudePromptScreenProof {
  if (!screen || screen.lines.length === 0) {
    return { ok: false, reason: "the pane's screen could not be read" }
  }
  if (screen.draft && screen.draft.trim() !== '') {
    return { ok: false, reason: "Orca's composer for this pane holds a draft" }
  }
  const box = findInputBox(screen.lines)
  if (!box) {
    return {
      ok: false,
      reason: "Claude's empty input box was not recognised on screen (a dialog, picker or multi-line draft may be open)"
    }
  }
  const boxAndFooter = box.region.slice(box.index - 1)
  for (const [pattern, reason] of BLOCKING_PATTERNS) {
    if (boxAndFooter.some((line) => pattern.test(line))) {
      return { ok: false, reason: `the screen does not show an idle empty prompt (${reason})` }
    }
  }
  const above = box.region.slice(Math.max(0, box.index - 1 - WORKING_ABOVE_LINES), box.index - 1)
  if (above.some((line) => WORKING_ABOVE_RE.test(line))) {
    return { ok: false, reason: 'the screen does not show an idle empty prompt (Claude is working)' }
  }
  const text = claudePromptLineText(screen.lines)
  if (text !== '') {
    return { ok: false, reason: "Claude's input box is not empty (a draft or placeholder is showing)" }
  }
  return { ok: true }
}
