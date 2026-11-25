// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import { describe, expect, it } from 'vitest'
import { parseRememberedViewModes, rememberViewMode } from './plugin-task-view-mode'

describe('plugin task view modes', () => {
  it('reads only list or board per source from storage', () => {
    expect(parseRememberedViewModes(null)).toEqual({})
    expect(parseRememberedViewModes('not json')).toEqual({})
    expect(parseRememberedViewModes('["board"]')).toEqual({})
    expect(parseRememberedViewModes('{"a::clickup":"board","b::x":"grid","c::y":"list"}')).toEqual({
      'a::clickup': 'board',
      'c::y': 'list'
    })
  })

  it('remembers the latest choice per source and drops the oldest past the cap', () => {
    let modes = rememberViewMode({}, 'a', 'board')
    modes = rememberViewMode(modes, 'b', 'list')
    modes = rememberViewMode(modes, 'a', 'list')
    expect(Object.entries(modes)).toEqual([
      ['b', 'list'],
      ['a', 'list']
    ])
    for (let index = 0; index < 25; index += 1) {
      modes = rememberViewMode(modes, `s${index}`, 'board')
    }
    expect(Object.keys(modes)).toHaveLength(20)
    expect(modes.a).toBeUndefined()
    expect(modes.s24).toBe('board')
  })
})
