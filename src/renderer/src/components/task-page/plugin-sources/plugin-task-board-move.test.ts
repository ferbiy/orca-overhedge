// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import { describe, expect, it } from 'vitest'
import { registerDemoTaskSource } from '../../../../../shared/plugins/tasks/demo-plugin-task-source.fake'
import type { PluginTaskItem } from '../../../../../shared/plugins/tasks/plugin-task-source-schema'
import { invokePluginTaskSource, type PluginCommandInvoker } from './plugin-task-source-client'
import { runPluginTaskBoardMove, type PluginTaskItemsUpdate } from './plugin-task-board-move'

const target = { pluginKey: 'overhedge.demo-tasks', sourceId: 'demo' }

function mount(refuseStatus?: string): {
  invoke: PluginCommandInvoker
  actions: unknown[]
  /** Lets a test run code while the action is in flight. */
  hold: (during: () => void) => void
} {
  const handlers = new Map<string, (args: unknown) => unknown>()
  registerDemoTaskSource(
    (id, handler) => handlers.set(id, handler),
    refuseStatus ? { refuseStatus } : {}
  )
  const actions: unknown[] = []
  let during: (() => void) | null = null
  const invoke: PluginCommandInvoker = async ({ commandId, args }) => {
    if (commandId.endsWith('.action')) {
      actions.push(args)
      during?.()
    }
    const handler = handlers.get(commandId)
    if (!handler) {
      throw new Error(`no command ${commandId}`)
    }
    return handler(args)
  }
  return { invoke, actions, hold: (fn) => (during = fn) }
}

/** The page's items as a little store the move updates, like `usePluginTaskList`. */
function itemsStore(initial: PluginTaskItem[]): {
  current: () => PluginTaskItem[]
  update: PluginTaskItemsUpdate
  set: (items: PluginTaskItem[]) => void
} {
  let items = initial
  return {
    current: () => items,
    update: (fn) => {
      items = fn(items)
    },
    set: (next) => {
      items = next
    }
  }
}

async function firstPage(invoke: PluginCommandInvoker) {
  const page = await invokePluginTaskSource(
    target,
    'list',
    { query: '', filters: { status: 'all' } },
    invoke
  )
  if (!page.board) {
    throw new Error('the demo source offers a board to a page with the board feature')
  }
  return { items: page.items, board: page.board }
}

describe('runPluginTaskBoardMove', () => {
  it('shows the move at once and then takes the source answer', async () => {
    const { invoke, actions, hold } = mount()
    const { items, board } = await firstPage(invoke)
    const store = itemsStore(items)
    const review = board.columns.find((column) => column.value === 'in-review')
    const card = items.find((entry) => entry.id === 'CU-1')
    if (!review || !card) {
      throw new Error('fixture')
    }
    let shownDuring: unknown
    hold(() => {
      shownDuring = store.current().find((entry) => entry.id === 'CU-1')?.status?.value
    })

    const outcome = await runPluginTaskBoardMove({
      target,
      item: card,
      column: review,
      moveActionId: board.moveActionId,
      updateItems: store.update,
      invoke
    })

    expect(outcome).toEqual({ ok: true, message: 'CU-1: In review' })
    expect(shownDuring).toBe('in-review')
    expect(actions).toEqual([
      {
        itemId: 'CU-1',
        actionId: 'set-status',
        value: 'in-review',
        features: ['status-color', 'board']
      }
    ])
    expect(store.current().find((entry) => entry.id === 'CU-1')).toMatchObject({
      status: { label: 'In review', tone: 'review', color: '#f8ae00', value: 'in-review' },
      url: 'https://app.clickup.example/t/CU-1'
    })
  })

  it('puts the card back and reports the error when the source refuses the move', async () => {
    const { invoke } = mount('done')
    const { items, board } = await firstPage(invoke)
    const store = itemsStore(items)
    const done = board.columns.find((column) => column.value === 'done')
    const card = items.find((entry) => entry.id === 'CU-2')
    if (!done || !card) {
      throw new Error('fixture')
    }

    const outcome = await runPluginTaskBoardMove({
      target,
      item: card,
      column: done,
      moveActionId: board.moveActionId,
      updateItems: store.update,
      invoke
    })

    expect(outcome).toEqual({ ok: false, error: 'unknown status done' })
    expect(store.current()).toEqual(items)
  })

  it('leaves a refreshed item alone when the move fails after the refresh', async () => {
    const { invoke, hold } = mount('done')
    const { items, board } = await firstPage(invoke)
    const store = itemsStore(items)
    const done = board.columns.find((column) => column.value === 'done')
    const card = items.find((entry) => entry.id === 'CU-2')
    if (!done || !card) {
      throw new Error('fixture')
    }
    const refreshed = items.map((entry) =>
      entry.id === 'CU-2'
        ? { ...entry, status: { label: 'To do', tone: 'open' as const, value: 'to-do' } }
        : entry
    )
    hold(() => store.set(refreshed))

    await runPluginTaskBoardMove({
      target,
      item: card,
      column: done,
      moveActionId: board.moveActionId,
      updateItems: store.update,
      invoke
    })

    expect(store.current()).toEqual(refreshed)
  })
})
