/** overhedge: the `chat:send` capability (`chat.list`, `chat.send`), kept apart so ports to a new
 *  upstream release touch plugin-capabilities.ts in three lines only. See OVERHEDGE.md. */

/** The fork release that first has it; upstream has no such capability. */
export const PLUGIN_CHAT_SEND_SINCE = '1.4.273'

export const PLUGIN_CHAT_SEND_DESCRIPTION =
  'List your open Orca chats (agent, chat and workspace names, on this computer and paired Orca servers) and send a message into one; it cannot read their messages, open new chats or type into terminals'
