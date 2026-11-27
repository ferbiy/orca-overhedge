// Overhedge: plugin projects on paired Orca servers; see OVERHEDGE.md "Plugin projects on paired servers".
import { z } from 'zod'
import type {
  PluginHostParams,
  PluginHostResult
} from '../../../../shared/plugins/workers/plugin-host-api'
import {
  PLUGIN_HOST_ID_MAX_LENGTH,
  PLUGIN_PROJECT_LIST_LIMIT,
  isPluginPlainLine,
  pluginWorkspaceId
} from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { isRepoHidden } from '../../../../shared/project/catalog/hidden-projects'
import { AGENT_STATUS_STATES } from '../../../../shared/agent-status/contracts/agent-status-types'
import { PLUGIN_AGENT_LIST_LIMIT } from '../../../../shared/plugins/workers/plugin-host-api-panel-methods'
import { suggestCreatureNameForPaths } from '../../../../shared/worktree/naming/worktree-name-suggestion'
import type { PluginHostMethodContext } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import {
  pluginRuntimeFailure,
  pluginWorkspaceSelector,
  type PluginRuntimeRpc
} from './plugin-host-runtime-call'
import { desktopPairedRuntimeHosts, type PairedRuntimeHosts } from './plugin-chat-paired-runtime'

/** overhedge: `project.list` also lists the projects of each paired Orca server this desktop has
 *  saved, `workspace.create` makes a workspace (and starts its agent) on that server, and
 *  `agents.list` with that server's `hostId` reads its agents, through the transport the desktop
 *  window uses for it, as Orca's own create does. Desktop only. */

const LIST_TIMEOUT_MS = 8_000
// A create runs Git and the project's setup on the server; Orca's own create allows 10 minutes.
const CREATE_TIMEOUT_MS = 10 * 60_000
const RUNTIME_PREFIX = 'runtime:'
const LABEL_MAX = 512

type ProjectList = PluginHostResult<'project.list'>
type Project = ProjectList['projects'][number]

// The parts of a server's answers read here; the rest is dropped.
const repoRow = z.object({
  id: z.string(),
  kind: z.string().optional(),
  displayName: z.string().optional(),
  path: z.string(),
  executionHostId: z.string().nullable().optional(),
  connectionId: z.string().nullable().optional(),
  hiddenAt: z.number().optional().catch(undefined)
})
const repoListAnswer = z.object({ repos: z.array(repoRow) })
const worktreeRecord = z.object({
  id: z.string(),
  identity: z.object({ key: z.string() }).optional()
})
const worktreeListAnswer = z.object({
  worktrees: z.array(worktreeRecord.extend({ repoId: z.string(), path: z.string() }))
})
const worktreeCreateAnswer = z.object({ worktree: worktreeRecord })
const agentLaunchAnswer = z.object({
  worktreeId: z.string(),
  outcome: z.object({ handle: z.string() })
})

/** One line, plain, at most `max`: a server's name comes from the person. */
function plainLabel(text: string, max: number): string {
  return [...text.replace(/\s+/g, ' ').trim()]
    .filter((char) => isPluginPlainLine(char))
    .join('')
    .slice(0, max)
}

/** A server's own projects (it answers about itself as `local`); rows it keeps for its own SSH
 *  hosts are left out, as no call from here reaches them. */
async function serverRepos(paired: PairedRuntimeHosts, environmentId: string, background: boolean) {
  const answer = await paired.call(
    environmentId,
    'repo.list',
    {},
    {
      timeoutMs: LIST_TIMEOUT_MS,
      background
    }
  )
  return repoListAnswer
    .parse(answer)
    .repos.filter(
      (repo) => repo.id.length > 0 && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
    )
}

/**
 * `project.list` on the desktop: this computer's projects, then each paired server's, with that
 * server's `runtime:` host and name. A server that cannot be reached now is named in
 * `unreachableHostIds`; the list still answers.
 */
export async function withPairedServerProjects(
  ctx: PluginHostMethodContext,
  local: ProjectList,
  paired: PairedRuntimeHosts
): Promise<ProjectList> {
  if (!ctx.services.desktop) {
    return local
  }
  const hostIds = await paired.hostIds()
  const unreachableHostIds: string[] = []
  const lists = await Promise.all(
    hostIds.map(async (hostId): Promise<Project[]> => {
      const environmentId = hostId.slice(RUNTIME_PREFIX.length)
      try {
        const [repos, label] = await Promise.all([
          serverRepos(paired, environmentId, true),
          paired.label(environmentId)
        ])
        const hostLabel = plainLabel(label ?? hostId, LABEL_MAX)
        return repos.map((repo) => ({
          id: repo.id,
          name: (repo.displayName ?? '').slice(0, LABEL_MAX),
          kind: repo.kind === 'folder' ? ('folder' as const) : ('git' as const),
          hostId,
          hostLabel,
          path: repo.path,
          hidden: isRepoHidden(repo)
        }))
      } catch {
        unreachableHostIds.push(hostId)
        return []
      }
    })
  )
  const fits = (project: Project) =>
    [project.id, project.path, project.hostId ?? ''].every(
      (v) => v.length <= PLUGIN_HOST_ID_MAX_LENGTH
    )
  const remote = lists.flat()
  const room = Math.max(0, PLUGIN_PROJECT_LIST_LIMIT - local.projects.length)
  const shown = remote.filter(fits)
  return {
    projects: [...local.projects, ...shown.slice(0, room)],
    truncated: local.truncated || shown.length > room || shown.length < remote.length,
    unreachableHostIds: unreachableHostIds.toSorted().slice(0, 32)
  }
}

/**
 * The paired server a `workspace.create` names, when its project lives there: the `hostId` is a
 * server this desktop has saved and this computer's catalog has no row of that project for that
 * host. Null otherwise, and outside the desktop app; the create then runs as before.
 */
export async function pairedCreateServer(
  ctx: PluginHostMethodContext,
  params: { projectId: string; hostId?: string },
  localCall: PluginRuntimeRpc,
  paired: PairedRuntimeHosts
): Promise<string | null> {
  const hostId = params.hostId
  if (!hostId?.startsWith(RUNTIME_PREFIX) || !ctx.services.desktop) {
    return null
  }
  if (!(await paired.hostIds()).includes(hostId)) {
    return null
  }
  const local = z
    .object({ repos: z.array(repoRow.partial({ path: true })) })
    .parse(await localCall('repo.list', {}))
  const mirrored = local.repos.some(
    (repo) => repo.id === params.projectId && getRepoExecutionHostId(repo) === hostId
  )
  return mirrored ? null : hostId.slice(RUNTIME_PREFIX.length)
}

/** A server's refusal as the plugin sees it: the same fixed messages a local create gives. */
function serverFailure(error: unknown): unknown {
  if (error instanceof Error && error.message === 'Setup decision required for this repository') {
    return new PluginHostCallError(
      'action_failed',
      "this project's setup script needs a decision; pass setup: 'skip' or create it in Orca",
      undefined,
      error.message
    )
  }
  return pluginRuntimeFailure(error)
}

/**
 * `workspace.create` on a paired server: the calls `orca worktree create --agent` makes there.
 * Never `run`, an approved setup hash or a startup command, as on this computer. The workspace
 * is made in the background: the server has no window to show it in, so `open` is refused.
 */
export async function createWorkspaceOnPairedServer(
  ctx: PluginHostMethodContext,
  params: PluginHostParams<'workspace.create'>,
  environmentId: string,
  paired: PairedRuntimeHosts
): Promise<PluginHostResult<'workspace.create'>> {
  if (params.open === true) {
    throw new PluginHostCallError(
      'action_failed',
      'a workspace on a paired Orca server cannot be opened from a plugin; leave open unset'
    )
  }
  const read = (method: string, args: unknown) =>
    paired
      .call(environmentId, method, args, { timeoutMs: LIST_TIMEOUT_MS })
      .catch((error: unknown) => {
        throw serverFailure(error)
      })
  const write = (method: string, args: unknown) => {
    ctx.scope.assertActive()
    return paired
      .call(environmentId, method, args, { timeoutMs: CREATE_TIMEOUT_MS })
      .catch((error: unknown) => {
        throw serverFailure(error)
      })
  }
  const repos = await serverRepos(paired, environmentId, false).catch((error: unknown) => {
    throw serverFailure(error)
  })
  const project = repos.find((repo) => repo.id === params.projectId)
  if (!project) {
    throw new PluginHostCallError('action_failed', 'no project has this id')
  }
  if (project.kind === 'folder') {
    throw new PluginHostCallError('action_failed', 'folder projects have no worktrees')
  }
  const { worktrees } = worktreeListAnswer.parse(
    await read('worktree.list', { limit: Number.MAX_SAFE_INTEGER })
  )
  const existing = worktrees.filter((worktree) => worktree.repoId === project.id)
  const name = params.name?.trim() || suggestCreatureNameForPaths(existing.map((w) => w.path))
  const create = {
    repo: `id:${project.id}`,
    name,
    ...(params.name
      ? { displayName: name, displayNameKind: 'user' }
      : { nameWasGenerated: true, displayNameKind: 'generated' }),
    ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
    setupDecision: params.setup === 'skip' ? 'skip' : 'inherit',
    activate: false
  }
  if (!params.agent) {
    const { worktree } = worktreeCreateAnswer.parse(await write('worktree.create', create))
    return {
      workspaceId: pluginWorkspaceId({ id: worktree.id, identityKey: worktree.identity?.key })
    }
  }
  const launched = agentLaunchAnswer.parse(
    await write('agent.launch', {
      target: { kind: 'create-worktree', create },
      agent: params.agent,
      surface: 'terminal',
      presentation: 'background',
      launchSource: 'plugin',
      ...(params.prompt ? { prompt: { text: params.prompt, delivery: 'submit' } } : {})
    })
  )
  const { worktree } = worktreeCreateAnswer.parse(
    await read('worktree.show', { worktree: `id:${launched.worktreeId}` })
  )
  return {
    workspaceId: pluginWorkspaceId({ id: worktree.id, identityKey: worktree.identity?.key }),
    terminalId: launched.outcome.handle
  }
}

// The parts of a server's `agent.list` row read here (what `orca agent list` reads).
const serverAgentListAnswer = z.object({
  agents: z.array(
    z.object({
      agent: z.string().nullable().optional(),
      state: z.enum(AGENT_STATUS_STATES),
      worktreeId: z.string().optional(),
      hostId: z.string().optional(),
      title: z.string().nullable().optional(),
      updatedAt: z.number().finite()
    })
  )
})

/**
 * `agents.list` for a workspace on a paired server (`hostId` as `project.list` gave it): that
 * server's agents in it, from its `agent.list`. A poll, so it does not wake an idle server.
 * Terminals there are not this computer's, so `terminalId` is null.
 */
export async function listPairedServerAgents(
  ctx: PluginHostMethodContext,
  params: { workspaceId?: string; hostId: string },
  paired: PairedRuntimeHosts
): Promise<PluginHostResult<'agents.list'>> {
  if (!ctx.services.desktop) {
    throw new PluginHostCallError('unavailable', 'only the Orca desktop app reaches paired servers')
  }
  if (!params.workspaceId) {
    throw new PluginHostCallError('action_failed', 'name the workspace with workspaceId')
  }
  if (
    !params.hostId.startsWith(RUNTIME_PREFIX) ||
    !(await paired.hostIds()).includes(params.hostId)
  ) {
    throw new PluginHostCallError('action_failed', 'no paired Orca server has this host id')
  }
  const environmentId = params.hostId.slice(RUNTIME_PREFIX.length)
  const read = (method: string, args: unknown) =>
    paired
      .call(environmentId, method, args, { timeoutMs: LIST_TIMEOUT_MS, background: true })
      .catch((error: unknown) => {
        throw serverFailure(error)
      })
  const { worktree } = worktreeCreateAnswer.parse(
    await read('worktree.show', { worktree: pluginWorkspaceSelector(params.workspaceId) })
  )
  const { agents } = serverAgentListAnswer.parse(
    await read('agent.list', { worktreeId: worktree.id })
  )
  return {
    agents: agents
      .filter(
        (row) =>
          row.worktreeId === worktree.id &&
          (row.hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
      )
      .slice(0, PLUGIN_AGENT_LIST_LIMIT)
      .map((row) => ({
        terminalId: null,
        title: row.title ? plainLabel(row.title, LABEL_MAX) || null : null,
        agent: row.agent ? plainLabel(row.agent, 128) || null : null,
        state: row.state,
        stateStartedAt: row.updatedAt
      }))
  }
}

/** `agents.list`: a workspace on a paired server (a `hostId` other than `local`) is read there;
 *  any other call runs `local`, upstream's handler. */
export function withPairedServerAgents<Local>(
  ctx: PluginHostMethodContext,
  params: { workspaceId?: string; hostId?: string } | undefined,
  local: (ctx: PluginHostMethodContext) => Promise<Local>
): Promise<Local | PluginHostResult<'agents.list'>> {
  const hostId = params?.hostId
  return hostId !== undefined && hostId !== LOCAL_EXECUTION_HOST_ID
    ? listPairedServerAgents(ctx, { ...params, hostId }, desktopPairedRuntimeHosts)
    : local(ctx)
}
