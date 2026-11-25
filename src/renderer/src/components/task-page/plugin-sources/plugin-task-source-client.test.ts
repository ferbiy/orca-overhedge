import { describe, expect, it } from 'vitest'
import { registerDemoTaskSource } from '../../../../../shared/plugins/tasks/demo-plugin-task-source.fake'
import { invokePluginTaskSource, type PluginCommandInvoker } from './plugin-task-source-client'

function mountDemo(): {
  invoke: PluginCommandInvoker
  calls: string[]
  state: ReturnType<typeof registerDemoTaskSource>
} {
  const handlers = new Map<string, (args: unknown) => unknown>()
  const state = registerDemoTaskSource((id, handler) => handlers.set(id, handler))
  const calls: string[] = []
  // Like main: an unknown command rejects, and Electron prefixes the channel.
  const invoke: PluginCommandInvoker = async ({ pluginKey, commandId, args }) => {
    calls.push(`${pluginKey} ${commandId}`)
    const handler = handlers.get(commandId)
    if (!handler) {
      throw new Error(
        `Error invoking remote method 'plugins:invokeCommand': Error: plugin ${pluginKey} does not contribute command ${commandId}`
      )
    }
    try {
      return await handler(args)
    } catch (error) {
      throw new Error(
        `Error invoking remote method 'plugins:invokeCommand': Error: ${(error as Error).message}`
      )
    }
  }
  return { invoke, calls, state }
}

const target = { pluginKey: 'overhedge.demo-tasks', sourceId: 'demo' }

describe('invokePluginTaskSource with the demo source', () => {
  it('lists, filters, searches and pages through its own command', async () => {
    const { invoke, calls } = mountDemo()
    const first = await invokePluginTaskSource(target, 'list', { query: '', filters: {} }, invoke)
    expect(first.items.map((item) => item.id)).toEqual(['CU-1', 'CU-2'])
    expect(first.nextCursor).toBeUndefined()
    expect(first.filters?.[0]?.id).toBe('status')
    expect(calls).toEqual(['overhedge.demo-tasks taskSource.demo.list'])

    const all = await invokePluginTaskSource(
      target,
      'list',
      { query: '', filters: { status: 'all' } },
      invoke
    )
    expect(all.items).toHaveLength(2)
    const rest = await invokePluginTaskSource(
      target,
      'list',
      { query: '', filters: { status: 'all' }, cursor: all.nextCursor },
      invoke
    )
    expect(rest.items.map((item) => item.id)).toEqual(['CU-3'])

    const searched = await invokePluginTaskSource(
      target,
      'list',
      { query: 'csv', filters: {} },
      invoke
    )
    expect(searched.items.map((item) => item.title)).toEqual(['Add CSV export'])
  })

  it('reads a detail with its actions, changes status and starts work', async () => {
    const { invoke, state } = mountDemo()
    const detail = await invokePluginTaskSource(target, 'get', { itemId: 'CU-1' }, invoke)
    expect(detail.item.url).toBe('https://app.clickup.example/t/CU-1')
    expect(detail.actions?.map((action) => action.id)).toEqual(['start', 'set-status'])

    const moved = await invokePluginTaskSource(
      target,
      'action',
      { itemId: 'CU-1', actionId: 'set-status', value: 'done' },
      invoke
    )
    expect(moved.detail?.item.status).toEqual({ label: 'Done', tone: 'done' })

    const started = await invokePluginTaskSource(
      target,
      'action',
      { itemId: 'CU-2', actionId: 'start', value: 'local:demo-repo' },
      invoke
    )
    expect(started.message).toBe('Started CU-2')
    expect(state.started).toEqual([{ taskId: 'CU-2', projectId: 'local:demo-repo' }])
  })

  it("surfaces the plugin's own error without the IPC prefix", async () => {
    const { invoke } = mountDemo()
    await expect(
      invokePluginTaskSource(target, 'get', { itemId: 'CU-404' }, invoke)
    ).rejects.toThrow(/^no task CU-404$/)
  })

  it('refuses a malformed answer', async () => {
    const invoke: PluginCommandInvoker = async () => ({ items: [{ id: '', title: 'x' }] })
    await expect(
      invokePluginTaskSource(target, 'list', { query: '', filters: {} }, invoke)
    ).rejects.toThrow(/invalid list result \(items\.0\.id:/)
  })
})
