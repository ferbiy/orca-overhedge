import { describe, expect, it } from 'vitest'
import type { PluginHostMethodContext } from './plugin-host-method-bind'
import type { PluginHostServices } from './plugin-host-method-bindings'
import { PairedRuntimeCallError, type PairedRuntimeHosts } from './plugin-chat-paired-runtime'
import {
  createWorkspaceOnPairedServer,
  listPairedServerAgents,
  pairedCreateServer,
  withPairedServerProjects
} from './plugin-host-paired-projects'

// overhedge: a plugin's project picker shows the paired server's projects, and a create for one
// of them runs on that server, never on this computer.

const LOCAL_LIST = {
  projects: [
    {
      id: 'mac-repo',
      name: 'future',
      kind: 'git' as const,
      hostId: 'local',
      path: '/Users/me/future'
    }
  ],
  truncated: false
}

function harness(options: { desktop?: boolean; down?: string[] } = {}) {
  const calls: { env: string; method: string; params: unknown; background?: boolean }[] = []
  const paired: PairedRuntimeHosts = {
    hostIds: async () => ['runtime:env1', 'runtime:env2'],
    label: async (env) => (env === 'env1' ? 'orca-ide‮' : null),
    call: async (env, method, params, callOptions) => {
      calls.push({ env, method, params, background: callOptions?.background })
      if (options.down?.includes(env)) {
        throw new PairedRuntimeCallError('client_disconnected', 'offline')
      }
      if (method === 'repo.list') {
        return {
          repos: [
            {
              id: 'srv-repo',
              displayName: 'overhedge_v2',
              kind: 'git',
              path: '/home/u/overhedge_v2',
              executionHostId: null
            },
            { id: 'srv-folder', displayName: 'notes', kind: 'folder', path: '/home/u/notes' },
            {
              id: 'srv-ssh',
              displayName: 'far',
              kind: 'git',
              path: '/far',
              executionHostId: 'ssh:box'
            },
            { id: 'srv-hidden', displayName: 'old', kind: 'git', path: '/old', hiddenAt: 5 }
          ]
        }
      }
      if (method === 'worktree.list') {
        return {
          worktrees: [
            { id: 'srv-repo::/home/u/ws/otter', repoId: 'srv-repo', path: '/home/u/ws/otter' }
          ]
        }
      }
      if (method === 'agent.launch') {
        return {
          worktreeId: 'srv-repo::/home/u/ws/task-1',
          outcome: { kind: 'terminal', handle: 'term_abc' }
        }
      }
      if (method === 'agent.list') {
        const row = (worktreeId: string, state: string, hostId = 'local') => ({
          kind: 'terminal',
          agent: 'claude',
          state,
          worktreeId,
          hostId,
          paneKey: 'tab:leaf',
          title: 'Task\u202e 1',
          workspace: 'task-1',
          updatedAt: 42
        })
        return {
          agents: [
            row('srv-repo::/home/u/ws/task-1', 'working'),
            row('srv-repo::/home/u/ws/otter', 'done'),
            row('srv-repo::/home/u/ws/task-1', 'done', 'ssh:box')
          ]
        }
      }
      if (method === 'worktree.show' || method === 'worktree.create') {
        return { worktree: { id: 'srv-repo::/home/u/ws/task-1' } }
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  let active = true
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only `desktop`
  const services = {
    desktop: options.desktop === false ? null : {}
  } as unknown as PluginHostServices
  const ctx: PluginHostMethodContext = {
    pluginId: 'ferbiy.clickup-tasks',
    surface: 'worker',
    services,
    scope: {
      assertActive: () => {
        if (!active) {
          throw new Error('revoked')
        }
      }
    }
  }
  return { paired, ctx, calls, revoke: () => (active = false) }
}

describe('project.list on paired servers', () => {
  it("adds each server's own projects with its host and name", async () => {
    const { ctx, paired, calls } = harness({ down: ['env2'] })
    const list = await withPairedServerProjects(ctx, LOCAL_LIST, paired)
    expect(list.projects).toEqual([
      LOCAL_LIST.projects[0],
      {
        id: 'srv-repo',
        name: 'overhedge_v2',
        kind: 'git',
        hostId: 'runtime:env1',
        hostLabel: 'orca-ide',
        path: '/home/u/overhedge_v2',
        hidden: false
      },
      expect.objectContaining({ id: 'srv-folder', kind: 'folder', hostId: 'runtime:env1' }),
      expect.objectContaining({ id: 'srv-hidden', hidden: true })
    ])
    expect(list.unreachableHostIds).toEqual(['runtime:env2'])
    expect(list.truncated).toBe(false)
    // A listing is a poll: it must not count as the person using an idle server.
    expect(calls.every((call) => call.background === true)).toBe(true)
  })

  it('stays local outside the desktop app', async () => {
    const { ctx, paired, calls } = harness({ desktop: false })
    expect(await withPairedServerProjects(ctx, LOCAL_LIST, paired)).toBe(LOCAL_LIST)
    expect(calls).toEqual([])
  })
})

describe('workspace.create on a paired server', () => {
  const localRpc = (repos: unknown[]) => async () => ({ repos })

  it('routes only a saved server whose project this computer does not hold', async () => {
    const { ctx, paired } = harness()
    expect(
      await pairedCreateServer(
        ctx,
        { projectId: 'srv-repo', hostId: 'runtime:env1' },
        localRpc([]),
        paired
      )
    ).toBe('env1')
    expect(
      await pairedCreateServer(
        ctx,
        { projectId: 'srv-repo', hostId: 'runtime:other' },
        localRpc([]),
        paired
      )
    ).toBeNull()
    expect(
      await pairedCreateServer(
        ctx,
        { projectId: 'mac-repo', hostId: 'local' },
        localRpc([]),
        paired
      )
    ).toBeNull()
    expect(
      await pairedCreateServer(ctx, { projectId: 'srv-repo' }, localRpc([]), paired)
    ).toBeNull()
    const mirrored = localRpc([{ id: 'srv-repo', executionHostId: 'runtime:env1' }])
    expect(
      await pairedCreateServer(
        ctx,
        { projectId: 'srv-repo', hostId: 'runtime:env1' },
        mirrored,
        paired
      )
    ).toBeNull()
    const { ctx: headless } = harness({ desktop: false })
    expect(
      await pairedCreateServer(
        headless,
        { projectId: 'srv-repo', hostId: 'runtime:env1' },
        localRpc([]),
        paired
      )
    ).toBeNull()
  })

  it('starts the agent there in the background with the prompt', async () => {
    const { ctx, paired, calls } = harness()
    const result = await createWorkspaceOnPairedServer(
      ctx,
      {
        projectId: 'srv-repo',
        hostId: 'runtime:env1',
        name: 'task-1',
        agent: 'claude',
        prompt: 'Do it'
      },
      'env1',
      paired
    )
    expect(result).toEqual({ workspaceId: 'srv-repo::/home/u/ws/task-1', terminalId: 'term_abc' })
    const launch = calls.find((call) => call.method === 'agent.launch')
    expect(launch?.env).toBe('env1')
    expect(launch?.params).toEqual({
      target: {
        kind: 'create-worktree',
        create: {
          repo: 'id:srv-repo',
          name: 'task-1',
          displayName: 'task-1',
          displayNameKind: 'user',
          setupDecision: 'inherit',
          activate: false
        }
      },
      agent: 'claude',
      surface: 'terminal',
      presentation: 'background',
      launchSource: 'plugin',
      prompt: { text: 'Do it', delivery: 'submit' }
    })
    expect(launch?.background).toBeUndefined()
  })

  it('refuses open, folders, unknown projects and a plugin that lost approval', async () => {
    const { ctx, paired, calls, revoke } = harness()
    const create = (params: { projectId: string; open?: boolean }) =>
      createWorkspaceOnPairedServer(ctx, { hostId: 'runtime:env1', ...params }, 'env1', paired)
    await expect(create({ projectId: 'srv-repo', open: true })).rejects.toThrow('cannot be opened')
    await expect(create({ projectId: 'srv-folder' })).rejects.toThrow(
      'folder projects have no worktrees'
    )
    await expect(create({ projectId: 'srv-ssh' })).rejects.toThrow('no project has this id')
    revoke()
    await expect(create({ projectId: 'srv-repo' })).rejects.toThrow('revoked')
    expect(
      calls.some((call) => call.method === 'worktree.create' || call.method === 'agent.launch')
    ).toBe(false)
  })

  it('names an unreachable server with the fixed message', async () => {
    const { ctx, paired } = harness({ down: ['env1'] })
    await expect(
      createWorkspaceOnPairedServer(
        ctx,
        { projectId: 'srv-repo', hostId: 'runtime:env1' },
        'env1',
        paired
      )
    ).rejects.toThrow('the host that owns this is not connected')
  })
})

describe('agents.list on a paired server', () => {
  it("reads that server's agents in the workspace, as a poll", async () => {
    const { ctx, paired, calls } = harness()
    const result = await listPairedServerAgents(
      ctx,
      { workspaceId: 'srv-repo::/home/u/ws/task-1', hostId: 'runtime:env1' },
      paired
    )
    expect(result).toEqual({
      agents: [
        { terminalId: null, title: 'Task 1', agent: 'claude', state: 'working', stateStartedAt: 42 }
      ]
    })
    expect(calls.find((call) => call.method === 'agent.list')).toMatchObject({
      env: 'env1',
      params: { worktreeId: 'srv-repo::/home/u/ws/task-1' },
      background: true
    })
  })

  it('refuses a host this desktop does not pair with, and headless serve', async () => {
    const { ctx, paired } = harness()
    await expect(
      listPairedServerAgents(ctx, { workspaceId: 'w', hostId: 'runtime:other' }, paired)
    ).rejects.toThrow('no paired Orca server has this host id')
    await expect(listPairedServerAgents(ctx, { hostId: 'runtime:env1' }, paired)).rejects.toThrow(
      'workspaceId'
    )
    const { ctx: headless } = harness({ desktop: false })
    await expect(
      listPairedServerAgents(headless, { workspaceId: 'w', hostId: 'runtime:env1' }, paired)
    ).rejects.toThrow('only the Orca desktop app')
  })
})
