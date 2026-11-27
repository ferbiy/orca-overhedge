// Overhedge: plugin status colours; see OVERHEDGE.md "Plugin status colours".
import { describe, expect, it } from 'vitest'
import { pluginStatusDotStyle, pluginStatusPillStyle } from './plugin-status-color-style'

describe('plugin status colour styles', () => {
  it('mixes a hex colour into the pill and dot styles', () => {
    expect(pluginStatusPillStyle('#5f55ee')).toMatchObject({
      '--linear-state-pill-background': 'color-mix(in srgb, #5f55ee 12%, transparent)'
    })
    expect(pluginStatusDotStyle('#abc')).toEqual({
      backgroundColor: 'color-mix(in srgb, #abc 42%, var(--foreground))'
    })
  })

  it('gives no style for anything but #rgb or #rrggbb', () => {
    for (const color of [
      undefined,
      '',
      'red',
      '#abcd',
      '#5f55ee80',
      ' #5f55ee',
      '#abc\n',
      '#5f55ee;background:url(x)',
      'var(--primary)',
      'rgb(1,2,3)'
    ]) {
      expect(pluginStatusPillStyle(color)).toBeUndefined()
      expect(pluginStatusDotStyle(color)).toBeUndefined()
    }
  })
})
