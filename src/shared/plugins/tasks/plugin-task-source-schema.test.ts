import { describe, expect, it } from 'vitest'
import { parsePluginTaskSourceResult } from './plugin-task-source-schema'

describe('plugin task source results', () => {
  it('accepts a list and drops fields it does not know, such as a #26282 start recipe', () => {
    const parsed = parsePluginTaskSourceResult('list', {
      items: [{ id: '1', title: 'One', start: { workspaceName: 'one' }, extra: true }]
    })
    expect(parsed).toEqual({ ok: true, value: { items: [{ id: '1', title: 'One' }] } })
  })

  it('refuses a non-http link and names the field', () => {
    const parsed = parsePluginTaskSourceResult('list', {
      items: [{ id: '1', title: 'One', url: 'javascript:alert(1)' }]
    })
    expect(parsed).toEqual({ ok: false, error: 'items.0.url: must be an http(s) URL' })
  })

  it('refuses an action id that is not kebab-case', () => {
    const parsed = parsePluginTaskSourceResult('get', {
      item: { id: '1', title: 'One' },
      actions: [{ id: 'Set Status', label: 'Status' }]
    })
    expect(parsed.ok).toBe(false)
  })

  it('reads an empty action answer as nothing to show', () => {
    expect(parsePluginTaskSourceResult('action', undefined)).toEqual({ ok: true, value: {} })
    expect(parsePluginTaskSourceResult('action', null)).toEqual({ ok: true, value: {} })
  })

  it('keeps a hex status or option colour and drops an invalid one without failing', () => {
    const parsed = parsePluginTaskSourceResult('get', {
      item: { id: '1', title: 'One', status: { label: 'Doing', tone: 'active', color: '#5F55EE' } },
      actions: [
        {
          id: 'set-status',
          label: 'Status',
          options: [
            { value: 'a', label: 'A', color: '#abc' },
            { value: 'b', label: 'B', color: 'red' },
            { value: 'c', label: 'C', color: '#abcd' },
            { value: 'd', label: 'D', color: '#fff;background:url(x)' },
            { value: 'e', label: 'E', color: 42 }
          ]
        }
      ]
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.value.item.status).toEqual({ label: 'Doing', tone: 'active', color: '#5F55EE' })
    expect(parsed.value.actions?.[0]?.options?.map((option) => option.color)).toEqual([
      '#abc',
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })

  it('drops an invalid item status colour and keeps the status', () => {
    const parsed = parsePluginTaskSourceResult('list', {
      items: [{ id: '1', title: 'One', status: { label: 'x', tone: 'open', color: 'var(--x)' } }]
    })
    expect(parsed).toEqual({
      ok: true,
      value: { items: [{ id: '1', title: 'One', status: { label: 'x', tone: 'open' } }] }
    })
  })

  it('reads board columns and the status value that names an item column', () => {
    const parsed = parsePluginTaskSourceResult('list', {
      items: [{ id: '1', title: 'One', status: { label: 'Doing', tone: 'active', value: 'doing' } }],
      board: {
        columns: [
          { value: 'todo', label: 'To do', tone: 'open', color: '#87909e' },
          { value: 'doing', label: 'Doing', tone: 'active', color: 'red' }
        ],
        moveActionId: 'set-status'
      }
    })
    expect(parsed).toEqual({
      ok: true,
      value: {
        items: [
          { id: '1', title: 'One', status: { label: 'Doing', tone: 'active', value: 'doing' } }
        ],
        board: {
          columns: [
            { value: 'todo', label: 'To do', tone: 'open', color: '#87909e' },
            { value: 'doing', label: 'Doing', tone: 'active' }
          ],
          moveActionId: 'set-status'
        }
      }
    })
  })

  it('drops a malformed board and keeps the list', () => {
    for (const board of [
      { columns: [], moveActionId: 'set-status' },
      { columns: [{ value: 'a', label: 'A', tone: 'open' }], moveActionId: 'Set Status' },
      {
        columns: [
          { value: 'a', label: 'A', tone: 'open' },
          { value: 'a', label: 'A again', tone: 'open' }
        ],
        moveActionId: 'set-status'
      },
      { columns: [{ value: 'a', label: 'A', tone: 'unknown' }], moveActionId: 'set-status' },
      'board'
    ]) {
      expect(
        parsePluginTaskSourceResult('list', { items: [{ id: '1', title: 'One' }], board })
      ).toEqual({ ok: true, value: { items: [{ id: '1', title: 'One' }] } })
    }
  })
})
