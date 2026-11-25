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
})
