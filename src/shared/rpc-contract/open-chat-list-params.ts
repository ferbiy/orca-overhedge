// Overhedge: `agent.listOpenChats`, the composer's "Open chats" mentions. See OVERHEDGE.md,
// "Chat mentions of open chats".
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

// Not strict: a newer client's fields must not break an older host's list.
export const OpenChatListParams = lazyZodSchema(() => z.object({}))
