// Overhedge: the parts of a paired Orca server's answers that plugin projects on paired servers
// read (see OVERHEDGE.md "Plugin projects on paired servers"); the rest is dropped.
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { AGENT_STATUS_STATES } from '../../../../shared/agent-status/contracts/agent-status-types'

export const repoRow = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    kind: z.string().optional(),
    displayName: z.string().optional(),
    path: z.string(),
    executionHostId: z.string().nullable().optional(),
    connectionId: z.string().nullable().optional(),
    hiddenAt: z.number().optional().catch(undefined)
  })
)
export const repoListAnswer = lazyZodSchema(() => z.object({ repos: z.array(repoRow) }))
const worktreeRecord = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    identity: z.object({ key: z.string() }).optional()
  })
)
export const worktreeListAnswer = lazyZodSchema(() =>
  z.object({
    worktrees: z.array(worktreeRecord.extend({ repoId: z.string(), path: z.string() }))
  })
)
export const worktreeCreateAnswer = lazyZodSchema(() => z.object({ worktree: worktreeRecord }))
export const agentLaunchAnswer = lazyZodSchema(() =>
  z.object({
    worktreeId: z.string(),
    outcome: z.object({ handle: z.string() })
  })
)

// The parts of a server's `agent.list` row read here (what `orca agent list` reads).
export const serverAgentListAnswer = lazyZodSchema(() =>
  z.object({
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
)
