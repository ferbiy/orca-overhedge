// Overhedge: the argument values the composer offers after `/orca-account ` and `/orca-migrate `:
// this host's managed Claude accounts (the chat's current one marked) and `auto`.
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import type { OrcaSlashArgumentChoice } from '../../../shared/native-chat/input/composer/orca-command-arguments'
import { claudeAccountLabel, pinnedClaudeAccountForChat } from './claude-chat-account-pins'

export type ClaudeAccountChoiceRouter = {
  pointerPath: string
  listAccounts(): readonly ClaudeManagedAccount[]
  selectedProfile(): { accountId: string } | null
}

const SHORT_ID = 8

/** The email when no other account has it (the commands accept it), else the id. */
function choiceValue(account: ClaudeManagedAccount, accounts: readonly ClaudeManagedAccount[]) {
  const email = account.email?.trim()
  if (!email || /\s/u.test(email)) {
    return account.id
  }
  const lower = email.toLowerCase()
  const shared = accounts.some(
    (other) =>
      other !== account &&
      (other.email?.trim().toLowerCase() === lower || other.id.toLowerCase() === lower)
  )
  return shared ? account.id : email
}

/** Empty when the host has no managed accounts (the commands then only explain that). */
export function claudeChatAccountChoices(
  router: ClaudeAccountChoiceRouter,
  sessionId: string
): OrcaSlashArgumentChoice[] {
  const accounts = router.listAccounts()
  if (accounts.length === 0) {
    return []
  }
  let pinned: ReturnType<typeof pinnedClaudeAccountForChat> = null
  try {
    pinned = pinnedClaudeAccountForChat(router, sessionId)
  } catch {
    // Unreadable pins: list the accounts without a current mark rather than none.
  }
  const selected = router.selectedProfile()?.accountId ?? null
  const currentId = pinned?.accountId ?? selected
  const why = pinned?.source === 'coordinator' ? 'inherited from its coordinator' : 'pinned'
  const selectedAccount = accounts.find((account) => account.id === selected)
  const rows: OrcaSlashArgumentChoice[] = accounts.map((account) => {
    const value = choiceValue(account, accounts)
    const id = `id ${account.id.slice(0, SHORT_ID)}`
    const name = value === account.id ? (account.email ? `${account.email}, ${id}` : id) : id
    if (account.id !== currentId) {
      return { value, description: name }
    }
    return pinned
      ? { value, hint: 'current', description: `${name}; this chat's account (${why})` }
      : { value, hint: 'global', description: `${name}; the global selection this chat follows` }
  })
  const auto = `Remove the pin; follow the global selection (${
    selectedAccount ? claudeAccountLabel(selectedAccount) : 'System default'
  })`
  rows.push(
    pinned
      ? { value: 'auto', description: auto }
      : { value: 'auto', hint: 'current', description: `${auto}; this chat is not pinned` }
  )
  return rows
}
