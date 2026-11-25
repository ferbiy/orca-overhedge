// Overhedge: plugin status colours; see OVERHEDGE.md "Plugin status colours".
import { describe, expect, it } from 'vitest'
import { parsePluginDeclarativeTree } from '../declarative/plugin-declarative-tree'
import { PLUGIN_DECLARATIVE_COMPONENT_PROPS } from '../declarative/plugin-declarative-message-names'
import { createOrcaSdk } from '../declarative/runtime/declarative-sdk'
import { isPluginHexColor, pluginOptionalHexColorSchema } from './plugin-status-color'

const INVALID = [
  '',
  'red',
  '#ab',
  '#abcd',
  '#5f55ee80',
  ' #abc',
  '#abc ',
  '#abc\n',
  '#ggg',
  'var(--primary)',
  'rgb(1, 2, 3)',
  '#fff;background:url(x)',
  42,
  null,
  undefined
]

describe('plugin hex colours', () => {
  it('accepts #rgb and #rrggbb in either case only', () => {
    for (const color of ['#abc', '#ABC', '#5f55ee', '#5F55EE', '#000000']) {
      expect(isPluginHexColor(color)).toBe(true)
    }
    for (const color of INVALID) {
      expect(isPluginHexColor(color)).toBe(false)
    }
  })

  it('reads an invalid colour in a task source answer as absent', () => {
    expect(pluginOptionalHexColorSchema.parse('#abc')).toBe('#abc')
    for (const color of INVALID) {
      expect(pluginOptionalHexColorSchema.parse(color)).toBeUndefined()
    }
  })
})

describe('components panel Badge color', () => {
  it('keeps a hex colour next to the tone', () => {
    const parsed = parsePluginDeclarativeTree({
      type: 'Badge',
      props: { tone: 'success', color: '#5f55ee' },
      children: ['in progress']
    })
    expect(parsed).toMatchObject({
      ok: true,
      tree: { type: 'Badge', props: { tone: 'success', color: '#5f55ee' } },
      warnings: []
    })
  })

  it('drops an invalid colour with a warning and still draws the Badge', () => {
    const parsed = parsePluginDeclarativeTree({
      type: 'Badge',
      props: { tone: 'warning', color: 'url(https://example.com/x)' },
      children: ['x']
    })
    expect(parsed).toMatchObject({
      ok: true,
      tree: { type: 'Badge', props: { tone: 'warning' } },
      warnings: ['Badge: ignored invalid color']
    })
    expect(parsed.ok && parsed.tree && 'color' in parsed.tree.props).toBe(false)
  })

  it("is advertised through ui.has('Badge', 'color')", () => {
    expect(PLUGIN_DECLARATIVE_COMPONENT_PROPS.Badge).toContain('color')
    const sdk = createOrcaSdk({ bridge: () => null, theme: () => ({ colorScheme: 'dark' }) })
    expect(sdk.ui.has('Badge', 'color')).toBe(true)
    expect(sdk.ui.has('Badge', 'tone')).toBe(true)
  })
})
