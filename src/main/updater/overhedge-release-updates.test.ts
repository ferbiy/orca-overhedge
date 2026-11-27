import { describe, expect, it } from 'vitest'
import { isOverhedgeDesktopBuild, overhedgeAllowsReleaseUpdates } from './overhedge-release-updates'

const FORK = '1.4.273+overhedge.21.g0123456789'

describe('isOverhedgeDesktopBuild', () => {
  it('matches the fork version stamp on macOS and Linux', () => {
    expect(isOverhedgeDesktopBuild('darwin', FORK)).toBe(true)
    expect(isOverhedgeDesktopBuild('linux', FORK)).toBe(true)
    expect(isOverhedgeDesktopBuild('win32', FORK)).toBe(false)
    expect(isOverhedgeDesktopBuild('darwin', '1.4.273')).toBe(false)
    expect(isOverhedgeDesktopBuild('linux', '1.4.273')).toBe(false)
    expect(isOverhedgeDesktopBuild('darwin', '1.4.273-local.1.abc')).toBe(false)
  })
})

describe('overhedgeAllowsReleaseUpdates', () => {
  it('turns release updates off for the fork desktop app on macOS and Linux', () => {
    expect(overhedgeAllowsReleaseUpdates('darwin', FORK, 'interactive')).toBe(false)
    expect(overhedgeAllowsReleaseUpdates('linux', FORK, 'interactive')).toBe(false)
  })

  it('leaves Linux orca serve (the server deb) on upstream behavior', () => {
    expect(overhedgeAllowsReleaseUpdates('linux', FORK, 'supervised-headless-serve')).toBe(true)
    expect(overhedgeAllowsReleaseUpdates('linux', FORK, 'unsupported-headless-serve')).toBe(true)
  })

  it('keeps the mac fork build off even in serve mode', () => {
    expect(overhedgeAllowsReleaseUpdates('darwin', FORK, 'supervised-headless-serve')).toBe(false)
  })

  it('leaves official builds alone', () => {
    expect(overhedgeAllowsReleaseUpdates('linux', '1.4.273', 'interactive')).toBe(true)
    expect(overhedgeAllowsReleaseUpdates('darwin', '1.4.273', 'interactive')).toBe(true)
  })
})
