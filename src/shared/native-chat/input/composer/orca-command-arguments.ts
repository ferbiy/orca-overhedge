// Overhedge: value completion for the arguments of Orca's own chat commands (`/orca-account`,
// `/orca-migrate`, `/rc`, `/remote-control`). The host that runs the chat attaches the values to
// its catalog rows (`orcaArguments`, e.g. the managed Claude accounts of that host); after
// `/<command> ` the composer lists them in the same `/` menu, and a pick inserts the value.
import type { AgentSessionSlashCommand } from '../../../agent-session/agent-session-wire'
import type { ComposerAutocomplete } from './native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from './native-chat-picker-items'

export type OrcaSlashArgumentChoice = {
  /** Exactly what a pick inserts; one word. */
  value: string
  /** Short text beside the value, e.g. `current`. */
  hint?: string
  description?: string
}

export type OrcaSlashArguments = {
  /** `positions[i]`: the choices for the i-th word after the command name. */
  positions: OrcaSlashArgumentChoice[][]
  /** The bare command only prints its usage, so choosing its row completes it instead of sending. */
  required?: true
}

/** A catalog row (wire or composer) that may carry argument choices. */
export type WithOrcaSlashArguments = { orcaArguments?: OrcaSlashArguments }

const MAX_POSITIONS = 4
const MAX_CHOICES = 64
const MAX_VALUE = 320
const MAX_TEXT = 200
const ID_PREFIX = 'orca-arg:'

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readChoice(entry: unknown): OrcaSlashArgumentChoice | null {
  if (!isRecord(entry)) {
    return null
  }
  const word = entry.value
  if (typeof word !== 'string' || !/^\S+$/u.test(word) || word.length > MAX_VALUE) {
    return null
  }
  const hint = text(entry.hint)
  const description = text(entry.description)
  return { value: word, ...(hint ? { hint } : {}), ...(description ? { description } : {}) }
}

/** The row's choices when they are well formed; anything else reads as none (a host may be newer). */
export function readOrcaSlashArguments(row: unknown): OrcaSlashArguments | undefined {
  const raw = isRecord(row) ? row.orcaArguments : undefined
  if (!isRecord(raw)) {
    return undefined
  }
  const positions = raw.positions
  if (!Array.isArray(positions)) {
    return undefined
  }
  const read = positions
    .slice(0, MAX_POSITIONS)
    .map((choices) =>
      Array.isArray(choices)
        ? choices.slice(0, MAX_CHOICES).flatMap((choice) => readChoice(choice) ?? [])
        : []
    )
  if (read.every((choices) => choices.length === 0)) {
    return undefined
  }
  return {
    positions: read,
    ...(raw.required === true ? { required: true as const } : {})
  }
}

/** Spread into a composer row built from a reported one, so the choices reach the picker. */
export function orcaSlashArgumentsField(row: AgentSessionSlashCommand): WithOrcaSlashArguments {
  const orcaArguments = readOrcaSlashArguments(row)
  return orcaArguments ? { orcaArguments } : {}
}

function argumentsOf(
  commands: readonly { name: string }[],
  name: string
): OrcaSlashArguments | undefined {
  const lower = name.toLowerCase()
  const row = commands.find((command) => command.name.toLowerCase() === lower)
  return row ? readOrcaSlashArguments(row) : undefined
}

/** Whether choosing this command's row should complete it (`/orca-migrate `) rather than send it. */
export function orcaSlashCommandNeedsArgument(
  commands: readonly { name: string }[],
  item: NativeChatPickerItem
): boolean {
  return (
    item.kind === 'command' &&
    item.orcaOwned !== true &&
    !isOrcaSlashArgumentItem(item) &&
    argumentsOf(commands, item.name)?.required === true
  )
}

// A draft-leading command, the words already typed after it, and the word at the caret.
const ARGUMENT_DRAFT = /^\/([\w:-]+)((?:[ \t]+\S+)*)[ \t]+(\S*)$/u

function rank(choice: OrcaSlashArgumentChoice, query: string): number | null {
  const value = choice.value.toLowerCase()
  if (!query || value.startsWith(query)) {
    return 0
  }
  if (value.includes(query)) {
    return 1
  }
  return choice.description?.toLowerCase().includes(query) === true ? 2 : null
}

/** The `/` menu for the argument at the caret, or null when the draft is not one of these. */
export function deriveOrcaSlashArgumentAutocomplete(
  before: string,
  commands: readonly { name: string }[],
  dismissedTriggerKey: string | null
): ComposerAutocomplete | null {
  const match = ARGUMENT_DRAFT.exec(before)
  if (!match) {
    return null
  }
  const [, name, typed, query] = match
  const choices = argumentsOf(commands, name)?.positions[typed.split(/\s+/u).filter(Boolean).length]
  if (!choices || choices.length === 0) {
    return null
  }
  const lower = query.toLowerCase()
  const shown = choices
    .map((choice, order) => ({ choice, order, rank: rank(choice, lower) }))
    .filter((entry): entry is { choice: OrcaSlashArgumentChoice; order: number; rank: number } =>
      entry.rank !== null
    )
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
  // A fully typed value leaves the menu closed, so Enter sends the command.
  if (shown.length === 0 || (shown.length === 1 && shown[0].choice.value.toLowerCase() === lower)) {
    return null
  }
  const triggerKey = `${ID_PREFIX}${before.length - query.length}`
  if (dismissedTriggerKey === triggerKey) {
    return { mode: 'none' }
  }
  return {
    mode: 'slash',
    query,
    triggerKey,
    prefix: '/',
    dispatchable: false,
    grouped: false,
    commandsEnabled: true,
    skillsEnabled: false,
    skillStatus: 'ready',
    items: shown.map(({ choice }) => ({
      kind: 'command' as const,
      id: `${ID_PREFIX}${choice.value}`,
      name: choice.value,
      token: choice.value,
      ...(choice.description ? { description: choice.description } : {}),
      ...(choice.hint ? { argumentHint: choice.hint } : {}),
      skillCollision: false
    }))
  }
}

export function isOrcaSlashArgumentItem(item: NativeChatPickerItem): boolean {
  return item.kind === 'command' && item.id.startsWith(ID_PREFIX)
}

/** Replace the word at the caret (and the rest of it after the caret) with the picked value. */
export function applyOrcaSlashArgument(
  draft: string,
  caret: number,
  item: NativeChatPickerItem
): { draft: string; caret: number; insertedToken: string; replacedEnd: number } {
  const before = draft.slice(0, caret)
  const start = before.length - (/\S*$/u.exec(before)?.[0].length ?? 0)
  const wordEnd = caret + (/^\S*/u.exec(draft.slice(caret))?.[0].length ?? 0)
  const replacedEnd = wordEnd + (draft[wordEnd] === ' ' ? 1 : 0)
  const nextBefore = `${before.slice(0, start)}${item.token} `
  return {
    draft: nextBefore + draft.slice(replacedEnd),
    caret: nextBefore.length,
    insertedToken: item.token,
    replacedEnd
  }
}
