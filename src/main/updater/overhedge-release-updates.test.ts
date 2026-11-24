import { describe, expect, it } from 'vitest'
import { isOverhedgeDesktopBuild } from './overhedge-release-updates'

describe('isOverhedgeDesktopBuild', () => {
  it('matches the fork version stamp on macOS only', () => {
    expect(isOverhedgeDesktopBuild('darwin', '1.4.273+overhedge.21.g0123456789')).toBe(true)
    expect(isOverhedgeDesktopBuild('linux', '1.4.273+overhedge.21.g0123456789')).toBe(false)
    expect(isOverhedgeDesktopBuild('darwin', '1.4.273')).toBe(false)
    expect(isOverhedgeDesktopBuild('darwin', '1.4.273-local.1.abc')).toBe(false)
  })
})
