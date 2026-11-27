// Overhedge: the "Open chats" group of the composer's `@` menu. See OVERHEDGE.md, "Chat mentions
// of open chats".
import { useTranslate } from '@/i18n/use-translate'
import { useShownOpenChatSnapshot, type OpenChatSnapshot } from './use-open-chat-mentions'

function statusLine(
  status: OpenChatSnapshot['statuses'][number],
  t: ReturnType<typeof useTranslate>
): string {
  switch (status.state) {
    case 'loading':
      return status.hostId === 'paired'
        ? t('overhedge.chatMentions.loadingServers', 'Reading chats on paired servers…')
        : t('overhedge.chatMentions.loading', 'Reading chats on {{value0}}…', {
            value0: status.label
          })
    case 'legacy':
      return t(
        'overhedge.chatMentions.legacy',
        '{{value0}} runs an older Orca: its chats show their titles, not their names',
        { value0: status.label }
      )
    case 'unreachable':
      return t('overhedge.chatMentions.unreachable', "{{value0}} can't be reached now", {
        value0: status.label
      })
  }
}

/** The open chats among the `@` rows, under their own heading, with a muted line for each host
 *  still being read, read without names, or out of reach. */
export function OpenChatsGroup({
  values,
  option
}: {
  values: readonly string[]
  option: (value: string, index: number) => React.JSX.Element
}): React.JSX.Element | null {
  const t = useTranslate()
  const { statuses } = useShownOpenChatSnapshot()
  if (values.length === 0) {
    return null
  }
  return (
    <>
      <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {t('overhedge.chatMentions.heading', 'Open chats')}
      </div>
      <div className="flex flex-col gap-0.5">{values.map(option)}</div>
      {statuses.map((status) => (
        <div key={status.hostId} className="px-2 py-1 text-2xs text-muted-foreground">
          {statusLine(status, t)}
        </div>
      ))}
    </>
  )
}
