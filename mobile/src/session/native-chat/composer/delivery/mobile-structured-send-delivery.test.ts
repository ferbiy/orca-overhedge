import { describe, expect, it } from 'vitest'
import type { AgentSessionSendResult } from '../../../../../../src/shared/agent-session/agent-session-wire'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'

describe('mobileStructuredSendDelivery', () => {
  // Overhedge: the reply a server sends for a chat command it answered itself (/rc, /orca-account);
  // claude-chat-account-pins.test.ts pins the server to this exact shape.
  it('does not report an Orca-answered command as not sent', () => {
    const value: AgentSessionSendResult = {
      clientMessageId: 'op-1',
      queued: { messageId: 'op-1', position: 0, state: 'dispatched' }
    }
    const delivery = mobileStructuredSendDelivery({ status: 'accepted', value })
    expect(delivery.error).toBeNull()
    expect(delivery.outcome).not.toBe('rejected')
  })
})
