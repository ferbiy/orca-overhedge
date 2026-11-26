import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import '../../../filesystem/atomic-file-publication'
import { mergeDirectoryIntoLink } from '../../../filesystem/merged-directory-link'
import { resolveClaudeDefaultHome } from '../claude-profile-paths'
import {
  createClaudeProfileReport,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from '../claude-profile-report'
import { mergeClaudeProfilePromptHistory } from './claude-profile-prompt-history'
import { shareClaudeProfileSessions } from './claude-profile-shared-sessions'

// `sessions` is shared separately (Overhedge: claude-profile-shared-sessions.ts).
export const CLAUDE_PROFILE_HISTORY_DIRS = [
  'projects',
  'session-env',
  'file-history',
  'shell-snapshots',
  'todos',
  'paste-cache',
  'tasks',
  'plans',
  'transcripts'
] as const

/** Link the default home's `name` folder in place of the profile's, moving its entries there. */
export function mergeClaudeProfileDirectory(
  profile: string,
  home: string,
  name: string,
  platform: NodeJS.Platform,
  report: ClaudeProfileReport
): Promise<ClaudeProfileSurfaceOutcome> {
  return mergeDirectoryIntoLink({
    source: join(profile, name),
    destination: join(home, name),
    platform,
    onWarning: (error) => warnClaudeProfile(report, name, error)
  })
}

/** Call after profile ownership checks and creation on the execution host. */
export async function shareClaudeProfileHistory(args: {
  profileHome: string
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR; `~/.claude` when unset. */
  userConfigDir?: string
  platform?: NodeJS.Platform
}): Promise<ClaudeProfileReport> {
  const report = createClaudeProfileReport()
  const platform = args.platform ?? process.platform
  const defaultHome = resolveClaudeDefaultHome(args.userHome, args.userConfigDir)
  mkdirSync(defaultHome, { recursive: true, mode: 0o700 })
  for (const name of CLAUDE_PROFILE_HISTORY_DIRS) {
    await runClaudeProfileSurface(report, name, () =>
      mergeClaudeProfileDirectory(args.profileHome, defaultHome, name, platform, report)
    )
  }
  // Overhedge: link the live-session registry too, so peers under other accounts are listed.
  await runClaudeProfileSurface(report, 'sessions', () =>
    shareClaudeProfileSessions({ profileHome: args.profileHome, defaultHome, platform, report })
  )
  await runClaudeProfileSurface(report, 'history.jsonl', () =>
    mergeClaudeProfilePromptHistory(args.profileHome, defaultHome, platform, report)
  )
  return report
}
