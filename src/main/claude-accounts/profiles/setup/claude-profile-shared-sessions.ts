// Overhedge: one live-session registry for every Claude config folder on the host, so Claude
// Code's cross-session messaging (ListAgents / SendMessage) reaches chats running under another
// Orca-managed account. See OVERHEDGE.md, "Cross-account Claude peers".
//
// Claude Code lists its peers from `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` and finds each
// peer's inbox key in `<pid>.<sha256 of socket path>.key` next to it; the inbox sockets
// themselves already live in one per-user folder (/tmp/cc-socks). Upstream gives every account
// folder a private `sessions` (and removes an earlier build's link), so a chat only sees peers
// that run under the same account. This links the account folder's `sessions` to the default
// home's (`~/.claude/sessions`, or the user's own CLAUDE_CONFIG_DIR), the folder System default
// sessions already use. Nothing else becomes shared: the login, `.claude.json`, the daemon
// and jobs stay per folder.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mergeDirectoryIntoLink } from '../../../filesystem/merged-directory-link'
import {
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from '../claude-profile-report'

export const CLAUDE_SHARED_SESSIONS_DIR = 'sessions'

/**
 * Link `<profileHome>/sessions` to `<defaultHome>/sessions`, moving the records of sessions that
 * run now into the shared folder (by hard link, so their writers keep their files). Running
 * Claude processes resolve the folder by path on every read and write, so they follow the link
 * without a restart. A name already in the shared folder wins; the other copy waits in
 * `sessions.orca-profile-merge`. A link the user pointed elsewhere is left alone.
 */
export async function shareClaudeProfileSessions(args: {
  profileHome: string
  defaultHome: string
  platform: NodeJS.Platform
  report: ClaudeProfileReport
}): Promise<ClaudeProfileSurfaceOutcome> {
  const destination = join(args.defaultHome, CLAUDE_SHARED_SESSIONS_DIR)
  // Claude makes this folder owner-only; keep it so when Orca makes it first.
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  return mergeDirectoryIntoLink({
    source: join(args.profileHome, CLAUDE_SHARED_SESSIONS_DIR),
    destination,
    platform: args.platform,
    onWarning: (error) => warnClaudeProfile(args.report, CLAUDE_SHARED_SESSIONS_DIR, error)
  })
}
