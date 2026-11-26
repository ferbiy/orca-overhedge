// Overhedge: plugin status colours; see OVERHEDGE.md "Plugin status colours".
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PluginTaskStatusPill } from '../../task-page/plugin-sources/PluginTaskStatusPill'
import { PluginDeclarativeColorBadge } from './PluginDeclarativeColorBadge'
import { PluginStatusColorDot } from './PluginStatusColorDot'

// ClickUp's default status colours, plus a light yellow and a near-black to show the text mix.
const STATUSES = [
  { label: 'to do', tone: 'open', color: '#87909e' },
  { label: 'in progress', tone: 'active', color: '#5f55ee' },
  { label: 'in review', tone: 'review', color: '#f8ae00' },
  { label: 'blocked', tone: 'blocked', color: '#e50000' },
  { label: 'complete', tone: 'done', color: '#008844' },
  { label: 'pale', tone: 'open', color: '#fff3a0' },
  { label: 'ink', tone: 'open', color: '#111' }
] as const

export const tasksPageStatusPills = defineFixture({
  width: 520,
  render: () => (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((status) => (
          <PluginTaskStatusPill key={status.label} status={status} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">tones (no colour):</span>
        <PluginTaskStatusPill status={{ label: 'open', tone: 'open' }} />
        <PluginTaskStatusPill status={{ label: 'active', tone: 'active' }} />
        <PluginTaskStatusPill status={{ label: 'done', tone: 'done' }} />
      </div>
      <ul className="flex w-48 flex-col rounded-md border border-border/50 p-1 text-sm">
        {STATUSES.slice(0, 5).map((status) => (
          <li key={status.label} className="flex items-center gap-2 rounded-sm px-2 py-1.5">
            <PluginStatusColorDot color={status.color} />
            {status.label}
          </li>
        ))}
      </ul>
    </div>
  )
})

export const componentsPanelColorBadges = defineFixture({
  width: 360,
  render: () => (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((status) => (
          <PluginDeclarativeColorBadge key={status.label} tone={undefined} color={status.color}>
            {status.label}
          </PluginDeclarativeColorBadge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(['neutral', 'accent', 'success', 'warning', 'danger'] as const).map((tone) => (
          <PluginDeclarativeColorBadge key={tone} tone={tone} color={undefined}>
            {tone}
          </PluginDeclarativeColorBadge>
        ))}
        <PluginDeclarativeColorBadge tone="success" color="red">
          invalid colour
        </PluginDeclarativeColorBadge>
      </div>
    </div>
  )
})
