// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import type React from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  registerDemoTaskSource,
  type DemoTask
} from '../../../../../shared/plugins/tasks/demo-plugin-task-source.fake'
import { PluginTaskSourcePage } from './PluginTaskSourcePage'
import { pluginTaskSourceKey, type ActivePluginTaskSource } from './plugin-task-source-state'
import { usePluginTaskViewModes } from './plugin-task-view-mode'

// Placeholder tasks only: no real tracker data.
const TASKS: DemoTask[] = [
  { id: 'DEMO-101', title: 'Sketch the onboarding checklist', status: 'to-do', priority: 'Low' },
  {
    id: 'DEMO-102',
    title: 'Fix the login redirect after a password reset',
    status: 'to-do',
    priority: 'High',
    owner: 'Alex Doe'
  },
  { id: 'DEMO-103', title: 'Add CSV export to reports', status: 'in-progress', owner: 'Sam Roe' },
  {
    id: 'DEMO-104',
    title: 'Retry webhooks with backoff',
    status: 'in-progress',
    priority: 'Urgent',
    owner: 'Alex Doe, Sam Roe'
  },
  { id: 'DEMO-105', title: 'Review the billing copy', status: 'in-review', priority: 'Normal' },
  { id: 'DEMO-106', title: 'Write release notes', status: 'done', owner: 'Kim Poe' }
]

const SOURCE: ActivePluginTaskSource = {
  key: pluginTaskSourceKey('overhedge.demo-tasks', 'demo'),
  pluginKey: 'overhedge.demo-tasks',
  sourceId: 'demo',
  pluginName: 'Demo tasks',
  title: 'Demo tasks',
  icon: 'calendar',
  operations: ['list', 'get', 'action']
}

/** Answers the page's plugin commands from the demo source, in board view. */
function setup(): void {
  const handlers = new Map<string, (args: unknown) => unknown>()
  registerDemoTaskSource((id, handler) => handlers.set(id, handler), {
    pageSize: 50,
    tasks: TASKS.map((task) => ({ ...task }))
  })
  Reflect.set(window.api, 'plugins', {
    ...window.api.plugins,
    invokeCommand: async ({ commandId, args }: { commandId: string; args?: unknown }) =>
      handlers.get(commandId)?.(args)
  })
  usePluginTaskViewModes.setState({ modes: { [SOURCE.key]: 'board' } })
}

function Page(): React.JSX.Element {
  return (
    <div className="flex h-[520px] flex-col">
      <PluginTaskSourcePage source={SOURCE} />
    </div>
  )
}

async function clickCard(frame: HTMLElement, title: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const card = [...frame.querySelectorAll<HTMLElement>('[role="button"]')].find((node) =>
      node.textContent?.includes(title)
    )
    if (card) {
      card.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const board = defineFixture({ width: 1280, setup, render: () => <Page /> })

export const boardWithDetail = defineFixture({
  width: 1280,
  setup,
  render: () => <Page />,
  interact: (frame) => clickCard(frame, 'Retry webhooks')
})
