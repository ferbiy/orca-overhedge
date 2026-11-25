import { describe, expect, it } from 'vitest'
import { effectivePluginTaskFilters } from './plugin-task-filter-selection'

const status = {
  id: 'status',
  label: 'Status',
  options: [
    { value: 'open', label: 'Open' },
    { value: 'done', label: 'Done' }
  ]
}

describe('effectivePluginTaskFilters', () => {
  it('keeps picks the source still offers and drops the rest', () => {
    expect(effectivePluginTaskFilters([status], { status: 'done', gone: 'x' })).toEqual({
      status: 'done'
    })
    expect(effectivePluginTaskFilters([status], { status: 'archived' })).toEqual({})
    expect(effectivePluginTaskFilters([], { status: 'done' })).toEqual({})
  })
})
