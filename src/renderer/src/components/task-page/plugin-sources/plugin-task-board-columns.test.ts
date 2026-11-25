// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import { describe, expect, it } from 'vitest'
import type {
  PluginTaskBoard,
  PluginTaskItem
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'
import {
  buildPluginTaskBoardSections,
  movePluginTaskItem,
  pluginTaskItemColumn,
  replacePluginTaskItem,
  revertPluginTaskItemMove
} from './plugin-task-board-columns'

const board: PluginTaskBoard = {
  moveActionId: 'set-status',
  columns: [
    { value: 'to do', label: 'to do', tone: 'open', color: '#87909e' },
    { value: 'in progress', label: 'in progress', tone: 'active', color: '#5f55ee' },
    { value: 'review', label: 'review', tone: 'review' },
    { value: 'complete', label: 'complete', tone: 'done', color: '#008844' }
  ]
}

const item = (id: string, status?: PluginTaskItem['status']): PluginTaskItem => ({
  id,
  title: `Task ${id}`,
  ...(status ? { status } : {})
})

describe('plugin task board columns', () => {
  it("keeps the source's column order, empty columns included, and places items by status value", () => {
    const sections = buildPluginTaskBoardSections(
      [
        item('1', { label: 'complete', tone: 'done', value: 'complete' }),
        item('2', { label: 'to do', tone: 'open', value: 'to do' }),
        item('3', { label: 'In Progress', tone: 'active', value: 'in progress' }),
        item('4', { label: 'to do', tone: 'open', value: 'to do' })
      ],
      board
    )
    expect(sections.map((section) => section.label)).toEqual([
      'to do',
      'in progress',
      'review',
      'complete'
    ])
    expect(sections.map((section) => section.items.map((entry) => entry.id))).toEqual([
      ['2', '4'],
      ['3'],
      [],
      ['1']
    ])
    expect(sections[0]?.status).toEqual({
      label: 'to do',
      tone: 'open',
      color: '#87909e',
      value: 'to do'
    })
  })

  it('matches by label (any case) when the item has no status value', () => {
    expect(
      pluginTaskItemColumn(item('1', { label: ' Review ', tone: 'review' }), board.columns)?.value
    ).toBe('review')
    // A value that names no column is not matched by label.
    expect(
      pluginTaskItemColumn(item('2', { label: 'review', tone: 'review', value: 'x' }), board.columns)
    ).toBeNull()
  })

  it('keeps items whose status no column names in extra lanes that take no drops', () => {
    const sections = buildPluginTaskBoardSections(
      [
        item('1', { label: 'blocked', tone: 'blocked', value: 'blocked' }),
        item('2'),
        item('3', { label: 'Blocked', tone: 'blocked', value: 'blocked' })
      ],
      board
    )
    const extras = sections.slice(board.columns.length)
    expect(extras.map((section) => [section.label, section.column, section.items.length])).toEqual([
      ['blocked', null, 2],
      ['', null, 1]
    ])
  })

  it('moves an item into a column, and puts it back only while it still shows that move', () => {
    const first = item('1', { label: 'to do', tone: 'open', value: 'to do' })
    const second = item('2')
    const review = { value: 'review', label: 'review', tone: 'review' } as const
    const moved = movePluginTaskItem([first, second], '1', review)
    expect(moved[0]?.status).toEqual({
      label: 'review',
      tone: 'review',
      color: undefined,
      value: 'review'
    })
    expect(moved[1]).toBe(second)

    expect(revertPluginTaskItemMove(moved, first, review)[0]?.status).toEqual(first.status)
    // A refresh landed in between with the source's own status: that one stays.
    const refreshed = [item('1', { label: 'complete', tone: 'done', value: 'complete' })]
    expect(revertPluginTaskItemMove(refreshed, first, review)).toEqual(refreshed)
  })

  it("replaces an item with the source's answer", () => {
    const next = { ...item('2'), title: 'Renamed' }
    expect(replacePluginTaskItem([item('1'), item('2')], next).map((entry) => entry.title)).toEqual([
      'Task 1',
      'Renamed'
    ])
  })
})
