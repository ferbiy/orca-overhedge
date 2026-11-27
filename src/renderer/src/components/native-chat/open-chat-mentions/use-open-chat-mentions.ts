// Overhedge: reads the open chats the composer's `@` menu offers. See OVERHEDGE.md, "Chat
// mentions of open chats".
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { isMac } from '@/app-shell/chrome/app-window-chrome'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  OPEN_CHAT_LIST_METHOD,
  openChatRowsOfAnswer,
  type OpenChatHostListing
} from '../../../../../shared/chat-mentions/open-chat-contracts'
import {
  listPairedOpenChats,
  type OpenChatPairedServers
} from '../../../../../shared/chat-mentions/open-chat-paired-servers'
import { isListedRemoteServer } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { CrewAgentMentions } from '../../orchestration-crew/native-chat-crew-mentions'
import {
  openChatMentions,
  withOpenChatMentions,
  type OpenChatSourceListing
} from './open-chat-mention-rows'

/** The structured chat whose composer this is (its transport): its session and the server it
 *  runs on, null for this computer. */
export type OpenChatComposerSelf = { sessionId: string; runtimeEnvironmentId: string | null }

const FRESH_MS = 10_000
const REMOTE_TIMEOUT_MS = 10_000

/** `paired`: the paired servers, before the desktop has listed them. */
type HostStatus = { hostId: string; label: string; state: 'loading' | 'unreachable' | 'legacy' }

export type OpenChatSnapshot = {
  listings: readonly OpenChatSourceListing[]
  /** Hosts still being read, or read without names, or out of reach: the group's footer. */
  statuses: readonly HostStatus[]
}

const EMPTY: OpenChatSnapshot = { listings: [], statuses: [] }

type Entry = { snapshot: OpenChatSnapshot; at: number; running: boolean }

// One cache for every composer: the open chats are the app's, not a chat's.
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function cacheKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

function localHostLabel(): string {
  return isMac
    ? translate('overhedge.chatMentions.thisMac', 'this Mac')
    : translate('overhedge.chatMentions.thisComputer', 'this computer')
}

function environmentName(environmentId: string): string {
  return (
    useAppStore
      .getState()
      .runtimeEnvironments.find((environment) => environment.id === environmentId)?.name ??
    environmentId
  )
}

function update(key: string, change: (snapshot: OpenChatSnapshot) => OpenChatSnapshot): void {
  const entry = entries.get(key)
  if (entry) {
    entries.set(key, { ...entry, snapshot: change(entry.snapshot) })
    emit()
  }
}

function settle(
  key: string,
  hostId: string,
  listing: OpenChatSourceListing | null,
  status?: HostStatus
) {
  update(key, (snapshot) => ({
    listings: [
      ...snapshot.listings.filter((entry) => entry.hostId !== hostId),
      ...(listing ? [listing] : [])
    ],
    statuses: [
      ...snapshot.statuses.filter((entry) => entry.hostId !== hostId),
      ...(status ? [status] : [])
    ]
  }))
}

function hostStatus(listing: OpenChatSourceListing): HostStatus | undefined {
  const { hostId, hostLabel: label } = listing
  return listing.unreachable
    ? { hostId, label, state: 'unreachable' }
    : listing.legacy
      ? { hostId, label, state: 'legacy' }
      : undefined
}

// Background reads: listing chats never wakes an idle host, and the desktop refuses a server the
// person disconnected.
const pairedServers = (environmentIds: readonly string[]): OpenChatPairedServers => ({
  servers: async () =>
    environmentIds.map((environmentId) => ({
      environmentId,
      label: environmentName(environmentId)
    })),
  call: (environmentId, method, params) =>
    callRuntimeRpc<unknown>({ kind: 'environment', environmentId }, method, params, {
      background: true,
      timeoutMs: REMOTE_TIMEOUT_MS
    })
})

function asSource(listing: OpenChatHostListing, sameHost: boolean): OpenChatSourceListing {
  return {
    ...listing,
    sameHost,
    hostLabel: listing.label ?? listing.environmentId ?? listing.hostId
  }
}

/** This app's chats and each paired server's, for a chat on this computer. */
async function readFromLocal(key: string): Promise<void> {
  const local = callRuntimeRpc<unknown>({ kind: 'local' }, OPEN_CHAT_LIST_METHOD, {})
    .then((answer) =>
      settle(key, 'local', {
        hostId: 'local',
        chats: openChatRowsOfAnswer(answer),
        sameHost: true,
        hostLabel: localHostLabel()
      })
    )
    .catch(() => settle(key, 'local', null))
  const servers = useAppStore
    .getState()
    .runtimeEnvironments.filter(isListedRemoteServer)
    .map((environment) => environment.id)
  const paired = listPairedOpenChats(pairedServers(servers)).then((listings) => {
    const read = listings.map((listing) => asSource(listing, false))
    // The servers' rows as this read found them: a server unpaired since drops out.
    update(key, (snapshot) => ({
      listings: [...snapshot.listings.filter((listing) => listing.hostId === 'local'), ...read],
      statuses: [
        ...snapshot.statuses.filter((status) => status.hostId === 'local'),
        ...read.flatMap((listing) => hostStatus(listing) ?? [])
      ]
    }))
  })
  await Promise.all([local, paired])
}

/** A paired server's own chats, for a chat on that server: mail from there reaches no others. */
async function readFromEnvironment(key: string, environmentId: string): Promise<void> {
  const [listing] = await listPairedOpenChats(pairedServers([environmentId]))
  if (listing) {
    const source = asSource(listing, true)
    settle(key, listing.hostId, listing.unreachable ? null : source, hostStatus(source))
  }
}

/** Reads the open chats for a composer on `target` unless a read is fresh or running. */
export function refreshOpenChats(target: RuntimeClientTarget, now = Date.now()): void {
  const key = cacheKey(target)
  const entry = entries.get(key)
  if (entry && (entry.running || now - entry.at < FRESH_MS)) {
    return
  }
  const pending: HostStatus =
    target.kind === 'local'
      ? { hostId: 'paired', label: '', state: 'loading' }
      : {
          hostId: `runtime:${target.environmentId}`,
          label: environmentName(target.environmentId),
          state: 'loading'
        }
  // Shown at once from the last read, if any, while this one runs.
  const snapshot = entry?.snapshot ?? EMPTY
  entries.set(key, {
    at: now,
    running: true,
    snapshot: {
      ...snapshot,
      statuses: [...snapshot.statuses.filter((status) => status.hostId !== pending.hostId), pending]
    }
  })
  emit()
  const read =
    target.kind === 'local' ? readFromLocal(key) : readFromEnvironment(key, target.environmentId)
  void read.finally(() => {
    const done = entries.get(key)
    if (done) {
      entries.set(key, { ...done, running: false, at: Date.now() })
      emit()
    }
  })
}

// The composer whose `@` menu is open now: the menu's footer reads its hosts.
let shownKey: string | null = null

/** The open chats known for a composer on `environmentId` (null: this computer), refreshed
 *  while `open`. */
function useOpenChatSnapshotFor(environmentId: string | null | undefined, open: boolean) {
  const target = useMemo<RuntimeClientTarget | null>(
    () =>
      environmentId === undefined
        ? null
        : environmentId
          ? { kind: 'environment', environmentId }
          : { kind: 'local' },
    [environmentId]
  )
  const key = target ? cacheKey(target) : null
  useEffect(() => {
    if (open && target) {
      shownKey = cacheKey(target)
      refreshOpenChats(target)
    }
  }, [open, target])
  return useSyncExternalStore(subscribe, () =>
    key ? (entries.get(key)?.snapshot ?? EMPTY) : EMPTY
  )
}

/** The open chats of the composer whose `@` menu is open. */
export function useShownOpenChatSnapshot(): OpenChatSnapshot {
  return useSyncExternalStore(subscribe, () =>
    shownKey ? (entries.get(shownKey)?.snapshot ?? EMPTY) : EMPTY
  )
}

/** The crew's `@` mentions with the app's open chats after them. Only a structured chat's
 *  composer (`self`) lists them; elsewhere the crew's stay as they are. */
export function useWithOpenChatMentions(
  crew: CrewAgentMentions,
  menuOpen: boolean,
  self: OpenChatComposerSelf | undefined
): CrewAgentMentions {
  const sessionId = self?.sessionId
  const snapshot = useOpenChatSnapshotFor(
    sessionId ? (self?.runtimeEnvironmentId ?? null) : undefined,
    menuOpen
  )
  return useMemo(() => {
    if (!sessionId || !menuOpen) {
      return crew
    }
    const crewAddresses = new Set(
      [...crew.references.values()].map((reference) => reference.address)
    )
    return withOpenChatMentions(
      crew,
      openChatMentions(snapshot.listings, { sessionId }, crewAddresses)
    )
  }, [crew, menuOpen, sessionId, snapshot])
}

/** Fixture seam: the snapshot the open `@` menu shows, as if just read from this computer. */
export function showOpenChatsForFixture(snapshot: OpenChatSnapshot): void {
  entries.set('local', { snapshot, at: Number.POSITIVE_INFINITY, running: false })
  shownKey = 'local'
  emit()
}

/** Test seam: forget every cached read. */
export function resetOpenChatsForTests(): void {
  entries.clear()
  shownKey = null
  emit()
}
