import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { PluginTaskSourceOperation } from './plugin-task-source-commands'
import { pluginHexColorSchema } from './plugin-status-color'

/**
 * Overhedge fork: what a plugin task source returns. Items, filters and details follow upstream
 * PR #26282 (`plugin-task-source.ts`), so a source written for either reads the same; `actions`
 * (status changes, starting work) is ours. A worker is untrusted, so every answer is parsed here
 * before anything renders it. Unknown fields are dropped rather than refused, so a source may
 * also carry #26282's start recipe.
 */

export const PLUGIN_TASK_LIST_ITEM_LIMIT = 500
export const PLUGIN_TASK_FILTER_LIMIT = 8
export const PLUGIN_TASK_BODY_MAX_CHARS = 512 * 1024
export const PLUGIN_TASK_ACTION_LIMIT = 8
export const PLUGIN_TASK_BOARD_COLUMN_LIMIT = 50

export const PLUGIN_TASK_STATUS_TONES = [
  'open',
  'active',
  'blocked',
  'review',
  'done',
  'closed'
] as const

export type PluginTaskStatusTone = (typeof PLUGIN_TASK_STATUS_TONES)[number]

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

const kebabIdSchema = lazyZodSchema(() =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case')
)

/** An item status or option colour: an invalid one is dropped, the rest of the answer still shows. */
export const pluginOptionalHexColorSchema = lazyZodSchema(() =>
  pluginHexColorSchema.optional().catch(undefined)
)

const optionSchema = lazyZodSchema(() =>
  z.object({
    value: z.string().max(256),
    label: z.string().min(1).max(128),
    count: z.number().int().nonnegative().optional(),
    /** `#rgb`/`#rrggbb`, drawn as a dot before the label; anything else is dropped. */
    color: pluginOptionalHexColorSchema
  })
)

export const pluginTaskItemSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().min(1).max(512),
    title: z.string().min(1).max(512),
    status: z
      .object({
        label: z.string().min(1).max(64),
        tone: z.enum(PLUGIN_TASK_STATUS_TONES),
        /** `#rgb`/`#rrggbb`: the pill takes this colour instead of the tone's; else dropped. */
        color: pluginOptionalHexColorSchema,
        /** The board column (its `value`) this status belongs to; without it the label is matched. */
        value: z.string().min(1).max(256).optional()
      })
      .optional(),
    priority: z.string().min(1).max(32).optional(),
    owner: z.string().min(1).max(256).optional(),
    labels: z.array(z.string().min(1).max(64)).max(16).optional(),
    /** ISO-8601 date or date-time. */
    updatedAt: z.string().min(1).max(64).optional(),
    summary: z.string().max(1024).optional(),
    url: z.string().max(2048).refine(isHttpUrl, 'must be an http(s) URL').optional()
  })
)

export type PluginTaskItem = z.infer<typeof pluginTaskItemSchema>

export const pluginTaskFilterSchema = lazyZodSchema(() =>
  z.object({
    id: kebabIdSchema,
    label: z.string().min(1).max(64),
    options: z.array(optionSchema).min(1).max(100),
    defaultValue: z.string().max(256).optional()
  })
)

export type PluginTaskFilter = z.infer<typeof pluginTaskFilterSchema>

export type PluginTaskListParams = {
  query: string
  filters: Record<string, string>
  cursor?: string
  /** Board only: just the items of this column (a column `value`), to load more of it. */
  column?: string
}

/** One board column: a status, in the order the source gives. */
export const pluginTaskBoardColumnSchema = lazyZodSchema(() =>
  z.object({
    /** What a drop sends as the move action's `value`; items name it in `status.value`. */
    value: z.string().min(1).max(256),
    label: z.string().min(1).max(64),
    tone: z.enum(PLUGIN_TASK_STATUS_TONES),
    color: pluginOptionalHexColorSchema
  })
)

export type PluginTaskBoardColumn = z.infer<typeof pluginTaskBoardColumnSchema>

/**
 * Overhedge fork, feature `board`: the columns for the current filters and the action a drop on
 * a column runs (`action({ itemId, actionId: moveActionId, value: column.value })`).
 */
export const pluginTaskBoardSchema = lazyZodSchema(() =>
  z.object({
    columns: z
      .array(pluginTaskBoardColumnSchema)
      .min(1)
      .max(PLUGIN_TASK_BOARD_COLUMN_LIMIT)
      .refine(
        (columns) => new Set(columns.map((column) => column.value)).size === columns.length,
        'column values must be unique'
      ),
    moveActionId: kebabIdSchema
  })
)

export type PluginTaskBoard = z.infer<typeof pluginTaskBoardSchema>

export const pluginTaskListResultSchema = lazyZodSchema(() =>
  z.object({
    items: z.array(pluginTaskItemSchema).max(PLUGIN_TASK_LIST_ITEM_LIMIT),
    nextCursor: z.string().min(1).max(1024).optional(),
    filters: z.array(pluginTaskFilterSchema).max(PLUGIN_TASK_FILTER_LIMIT).optional(),
    /** One-line status the source wants shown above the list. */
    notice: z.string().min(1).max(512).optional(),
    /** A malformed board is dropped (the list still shows), so the page stays list-only. */
    board: pluginTaskBoardSchema.optional().catch(undefined)
  })
)

export type PluginTaskListResult = z.infer<typeof pluginTaskListResultSchema>

/**
 * Something the person can do to an item, run by the plugin's `action` command. With `options`
 * the person picks one first (a status, the project to start in); `value` is the current one.
 */
export const pluginTaskActionSchema = lazyZodSchema(() =>
  z.object({
    id: kebabIdSchema,
    label: z.string().min(1).max(64),
    options: z.array(optionSchema).min(1).max(200).optional(),
    value: z.string().max(256).optional(),
    /** Shown as the primary button. */
    primary: z.boolean().optional()
  })
)

export type PluginTaskAction = z.infer<typeof pluginTaskActionSchema>

export const pluginTaskDetailSchema = lazyZodSchema(() =>
  z.object({
    item: pluginTaskItemSchema,
    bodyMarkdown: z.string().max(PLUGIN_TASK_BODY_MAX_CHARS).optional(),
    actions: z.array(pluginTaskActionSchema).max(PLUGIN_TASK_ACTION_LIMIT).optional()
  })
)

export type PluginTaskDetail = z.infer<typeof pluginTaskDetailSchema>

export type PluginTaskActionParams = { itemId: string; actionId: string; value?: string }

export const pluginTaskActionResultSchema = lazyZodSchema(() =>
  z
    .object({
      /** Shown as a toast. */
      message: z.string().min(1).max(512).optional(),
      /** The item after the action; absent leaves the shown detail to a refetch. */
      detail: pluginTaskDetailSchema.optional()
    })
    .nullish()
    .transform((value) => value ?? {})
)

export type PluginTaskActionResult = z.infer<typeof pluginTaskActionResultSchema>

export type PluginTaskSourceResult<O extends PluginTaskSourceOperation> = O extends 'list'
  ? PluginTaskListResult
  : O extends 'get'
    ? PluginTaskDetail
    : PluginTaskActionResult

const RESULT_SCHEMAS: { [O in PluginTaskSourceOperation]: z.ZodType<PluginTaskSourceResult<O>> } = {
  list: pluginTaskListResultSchema,
  get: pluginTaskDetailSchema,
  action: pluginTaskActionResultSchema
}

/** Validates an untrusted worker answer for one operation. */
export function parsePluginTaskSourceResult<O extends PluginTaskSourceOperation>(
  operation: O,
  value: unknown
): { ok: true; value: PluginTaskSourceResult<O> } | { ok: false; error: string } {
  const schema: z.ZodType<PluginTaskSourceResult<O>> = RESULT_SCHEMAS[operation]
  const parsed = schema.safeParse(value)
  if (parsed.success) {
    return { ok: true, value: parsed.data }
  }
  const issue = parsed.error.issues[0]
  const path = issue?.path.join('.') || '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid result'}` }
}
