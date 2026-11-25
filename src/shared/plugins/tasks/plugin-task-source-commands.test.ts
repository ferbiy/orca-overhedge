import { describe, expect, it } from 'vitest'
import {
  collectPluginTaskSources,
  parsePluginTaskSourceCommandId,
  pluginTaskSourceCommandId,
  splitPluginTaskSourceCommands,
  withPluginTaskSources
} from './plugin-task-source-commands'
import { DEMO_TASK_SOURCE_COMMANDS } from './demo-plugin-task-source.fake'
import { parsePluginManifest } from '../manifest/plugin-manifest'

describe('plugin task source commands', () => {
  it('round-trips command ids and refuses other shapes', () => {
    expect(parsePluginTaskSourceCommandId(pluginTaskSourceCommandId('clickup', 'list'))).toEqual({
      sourceId: 'clickup',
      operation: 'list'
    })
    expect(parsePluginTaskSourceCommandId('taskSource.clickup.delete')).toBeNull()
    expect(parsePluginTaskSourceCommandId('taskSource.list')).toBeNull()
    expect(parsePluginTaskSourceCommandId('other.clickup.list')).toBeNull()
    expect(parsePluginTaskSourceCommandId('taskSource.click.up.list')).toBeNull()
  })

  it('collects a source per list command, titled by it', () => {
    expect(
      collectPluginTaskSources([
        ...DEMO_TASK_SOURCE_COMMANDS,
        { id: 'taskSource.orphan.get', title: 'No list, no source' },
        { id: 'refresh', title: 'Refresh' }
      ])
    ).toEqual([{ id: 'demo', title: 'Demo tasks', operations: ['list', 'get', 'action'] }])
  })

  it('moves task-source commands out of the palette list', () => {
    const refresh = { id: 'refresh', title: 'Refresh' }
    const split = splitPluginTaskSourceCommands([refresh, ...DEMO_TASK_SOURCE_COMMANDS])
    expect(split.commands).toEqual([refresh])
    expect(split.taskSources?.map((source) => source.id)).toEqual(['demo'])
    const entry = { pluginKey: 'p', commands: [refresh] }
    expect(withPluginTaskSources(entry)).toBe(entry)
  })

  it('declares a source in a manifest stock Orca accepts', () => {
    const parsed = parsePluginManifest({
      manifestVersion: 2,
      execution: 'trusted-worker',
      id: 'demo-tasks',
      name: 'Demo tasks',
      version: '0.1.0',
      engines: { orca: '>=1.4.273' },
      pluginApi: 1,
      main: 'worker/main.mjs',
      contributes: { commands: DEMO_TASK_SOURCE_COMMANDS }
    })
    expect(parsed.ok ? null : parsed.error).toBeNull()
  })
})
