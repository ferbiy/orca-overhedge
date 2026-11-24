// Overhedge: the fork's macOS desktop build (version `<base>+overhedge.<n>.g<sha>`, stamped by the
// fork's mac workflow) must never replace itself with an official Orca release. Its signature is
// ad-hoc, so Squirrel.Mac could not verify one anyway; this stops the checks, downloads and nudges
// the same way an unpackaged build does. Linux (the server deb) keeps upstream's behavior.
import { app } from 'electron'

export function isOverhedgeDesktopBuild(platform: NodeJS.Platform, version: string): boolean {
  return platform === 'darwin' && /\+overhedge\./.test(version)
}

/** `app.isPackaged`, except false for the fork's macOS build: the release updater stays off. */
export function releaseUpdatesEnabled(): boolean {
  if (!app.isPackaged) {
    return false
  }
  return process.platform !== 'darwin' || !isOverhedgeDesktopBuild('darwin', app.getVersion())
}
