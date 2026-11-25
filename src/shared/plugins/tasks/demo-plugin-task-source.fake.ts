import { pluginTaskSourceCommandId } from './plugin-task-source-commands'

/**
 * A fake plugin task source, written the way a plugin worker would: its manifest commands and the
 * handlers its `activate` registers with `orca.commands.register`. Tests drive the whole path
 * with it; a real plugin (ClickUp) does the same against its tracker.
 */

export const DEMO_TASK_SOURCE_ID = 'demo'

export const DEMO_TASK_SOURCE_COMMANDS = [
  { id: pluginTaskSourceCommandId(DEMO_TASK_SOURCE_ID, 'list'), title: 'Demo tasks' },
  { id: pluginTaskSourceCommandId(DEMO_TASK_SOURCE_ID, 'get'), title: 'Demo tasks: details' },
  { id: pluginTaskSourceCommandId(DEMO_TASK_SOURCE_ID, 'action'), title: 'Demo tasks: action' }
]

const STATUSES = [
  { value: 'to-do', label: 'To do', tone: 'open' },
  { value: 'in-progress', label: 'In progress', tone: 'active' },
  { value: 'done', label: 'Done', tone: 'done' }
] as const

function field(args: unknown, key: string): unknown {
  return args && typeof args === 'object'
    ? Object.entries(args).find(([name]) => name === key)?.[1]
    : undefined
}

function text(args: unknown, key: string): string | undefined {
  const value = field(args, key)
  return typeof value === 'string' ? value : undefined
}

type DemoTask = { id: string; title: string; status: (typeof STATUSES)[number]['value'] }

type CommandHandler = (args: unknown) => unknown

export function registerDemoTaskSource(
  register: (commandId: string, handler: CommandHandler) => void,
  options: { pageSize?: number; projects?: { id: string; name: string }[] } = {}
): { tasks: DemoTask[]; started: { taskId: string; projectId: string }[] } {
  const pageSize = options.pageSize ?? 2
  const projects = options.projects ?? [{ id: 'local:demo-repo', name: 'demo-repo' }]
  const tasks: DemoTask[] = [
    { id: 'CU-1', title: 'Fix the login redirect', status: 'to-do' },
    { id: 'CU-2', title: 'Add CSV export', status: 'in-progress' },
    { id: 'CU-3', title: 'Write release notes', status: 'done' }
  ]
  const started: { taskId: string; projectId: string }[] = []

  const toItem = (task: DemoTask) => {
    const status = STATUSES.find((entry) => entry.value === task.status) ?? STATUSES[0]
    return {
      id: task.id,
      title: task.title,
      status: { label: status.label, tone: status.tone },
      url: `https://app.clickup.example/t/${task.id}`
    }
  }
  const detail = (task: DemoTask) => ({
    item: toItem(task),
    bodyMarkdown: `Task **${task.id}**`,
    actions: [
      {
        id: 'start',
        label: 'Start agent',
        primary: true,
        options: projects.map((project) => ({ value: project.id, label: project.name }))
      },
      {
        id: 'set-status',
        label: 'Status',
        value: task.status,
        options: STATUSES.map((entry) => ({ value: entry.value, label: entry.label }))
      }
    ]
  })
  const find = (id: unknown) => {
    const task = tasks.find((entry) => entry.id === id)
    if (!task) {
      throw new Error(`no task ${String(id)}`)
    }
    return task
  }

  register(DEMO_TASK_SOURCE_COMMANDS[0].id, (args) => {
    const query = text(args, 'query') ?? ''
    const cursor = text(args, 'cursor')
    const status = text(field(args, 'filters'), 'status') ?? 'open'
    const matching = tasks.filter(
      (task) =>
        task.title.toLowerCase().includes(query.toLowerCase()) &&
        (status === 'all' || (status === 'open' ? task.status !== 'done' : task.status === status))
    )
    const start = cursor ? Number(cursor) : 0
    const next = start + pageSize
    return {
      items: matching.slice(start, next).map(toItem),
      ...(next < matching.length ? { nextCursor: String(next) } : {}),
      filters: [
        {
          id: 'status',
          label: 'Status',
          defaultValue: 'open',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
            ...STATUSES.map((entry) => ({ value: entry.value, label: entry.label }))
          ]
        }
      ]
    }
  })
  register(DEMO_TASK_SOURCE_COMMANDS[1].id, (args) => detail(find(field(args, 'itemId'))))
  register(DEMO_TASK_SOURCE_COMMANDS[2].id, (args) => {
    const task = find(field(args, 'itemId'))
    const actionId = text(args, 'actionId')
    const value = text(args, 'value')
    if (actionId === 'set-status') {
      const status = STATUSES.find((entry) => entry.value === value)
      if (!status) {
        throw new Error(`unknown status ${String(value)}`)
      }
      task.status = status.value
      return { message: `${task.id}: ${status.label}`, detail: detail(task) }
    }
    if (actionId === 'start') {
      // A real source calls workspace.create({ projectId, hostId, name, agent, prompt, open }).
      started.push({ taskId: task.id, projectId: String(value) })
      task.status = 'in-progress'
      return { message: `Started ${task.id}`, detail: detail(task) }
    }
    throw new Error(`unknown action ${String(actionId)}`)
  })
  return { tasks, started }
}
