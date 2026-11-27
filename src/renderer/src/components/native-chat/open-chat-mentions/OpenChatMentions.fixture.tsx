import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatRoomContext } from '../native-chat-room-context'
import { NativeChatMentionMenu } from '../composer/pickers/NativeChatAutocompleteMenus'
import type { OpenChatRow } from '../../../../../shared/chat-mentions/open-chat-contracts'
import { openChatMentions, rankOpenChatMentions } from './open-chat-mention-rows'
import { showOpenChatsForFixture } from './use-open-chat-mentions'

const row = (address: string, extra: Partial<OpenChatRow>): OpenChatRow => ({
  address,
  kind: 'chat',
  agent: 'claude',
  state: 'done',
  workspace: 'orca-overhedge',
  title: null,
  updatedAt: 1,
  ...extra
})

// Named chats on this Mac and on orca-ide (two "maestro"s told apart), a Codex chat, a renamed
// terminal Claude, and a chat nobody named (its Orca title, de-emphasised).
const { mentions } = openChatMentions(
  [
    {
      hostId: 'local',
      sameHost: true,
      hostLabel: 'this Mac',
      chats: [
        row('orca_session_id:claude_312a9f19_a', {
          userName: 'orca-ide fork',
          state: 'working',
          updatedAt: 9
        }),
        row('orca_session_id:claude_7f3c0000_a', {
          userName: 'maestro',
          workspace: 'overhedge-api',
          updatedAt: 8
        }),
        row('term_paper1', {
          kind: 'terminal',
          userName: 'paper',
          workspace: 'notes',
          updatedAt: 7
        }),
        row('orca_session_id:codex_00000001_a', {
          agent: 'codex',
          userName: 'review bot',
          updatedAt: 6
        }),
        row('orca_session_id:0a84fe87_a', {
          title: 'Investigate (research only)',
          updatedAt: 5,
          state: 'blocked'
        })
      ]
    },
    {
      hostId: 'runtime:e1',
      label: 'orca-ide',
      selector: 'orca-ide',
      sameHost: false,
      hostLabel: 'orca-ide',
      chats: [
        row('orca_session_id:claude_594cc7a4_a', {
          userName: 'MAESTRO',
          workspace: 'maestro',
          state: 'working'
        })
      ]
    }
  ],
  { sessionId: 'fixture-self-chat' }
)

const ROOM = { replies: null, mentions: [], withFiles: true, unavailable: [], agents: mentions }

const menu = (query: string) => {
  const values = rankOpenChatMentions(mentions, query)
  return (
    // The menu floats above the composer it belongs to: room for it, then a composer stand-in.
    <div className="flex h-[400px] flex-col justify-end p-2">
      <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
        @{query}
        <NativeChatRoomContext.Provider value={ROOM}>
          <NativeChatMentionMenu
            mention={{ files: [...values, 'src/main/index.ts'], loading: false, failed: false }}
            activeIndex={0}
            listboxId="open-chats-fixture"
            onChoose={() => {}}
          />
        </NativeChatRoomContext.Provider>
      </div>
    </div>
  )
}

export const bare = defineFixture({
  width: 420,
  setup: () =>
    showOpenChatsForFixture({
      listings: [],
      statuses: [{ hostId: 'runtime:e2', label: 'old box', state: 'legacy' }]
    }),
  render: () => menu('')
})

export const typed = defineFixture({
  width: 420,
  setup: () => showOpenChatsForFixture({ listings: [], statuses: [] }),
  render: () => menu('mae')
})
