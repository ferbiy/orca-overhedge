// Overhedge: the fork's desktop builds (version `<base>+overhedge.<n>.g<sha>`, stamped by the fork's
// mac and Linux workflows) must never replace themselves with an official Orca release. This stops
// the checks, downloads and nudges the same way an unpackaged build does: on macOS (ad-hoc
// signature, Squirrel.Mac could not verify one anyway) and in the Linux desktop app (.deb or
// AppImage). `orca serve` on Linux (the team server's deb) keeps upstream's behavior: it reports
// `manual-service-update-required` and never installs a release on its own.
import { app } from 'electron'
import type { UpdateInstallMode } from './lifecycle/updater-state'

export function isOverhedgeDesktopBuild(platform: NodeJS.Platform, version: string): boolean {
  return (platform === 'darwin' || platform === 'linux') && /\+overhedge\./.test(version)
}

/** False for a fork build except Linux `orca serve`; true for every other build. */
export function overhedgeAllowsReleaseUpdates(
  platform: NodeJS.Platform,
  version: string,
  installMode: UpdateInstallMode
): boolean {
  if (!isOverhedgeDesktopBuild(platform, version)) {
    return true
  }
  return platform === 'linux' && installMode !== 'interactive'
}

/** `app.isPackaged`, except false for the fork's desktop builds: the release updater stays off. */
export function releaseUpdatesEnabled(installMode: UpdateInstallMode): boolean {
  if (!app.isPackaged) {
    return false
  }
  return overhedgeAllowsReleaseUpdates(process.platform, app.getVersion(), installMode)
}
