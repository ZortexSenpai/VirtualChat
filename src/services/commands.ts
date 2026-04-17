import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk'

export interface CommandContext {
  client: MatrixClient
  roomId: string | null
  replyTo: MatrixEvent | null
  sendTextMessage: (text: string, replyTo?: MatrixEvent | null) => Promise<void>
  inviteUser: (roomId: string, userId: string) => Promise<void>
  kickMember: (roomId: string, userId: string, reason?: string) => Promise<void>
  banMember: (roomId: string, userId: string, reason?: string) => Promise<void>
  joinRoom: (roomId: string) => Promise<string>
}

export interface CommandResult {
  info?: string
}

export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
  usage?: string
  hidden?: boolean
  run: (args: string, ctx: CommandContext) => Promise<CommandResult | void> | CommandResult | void
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function appendShrug(args: string, suffix: string): string {
  const trimmed = args.trim()
  return trimmed ? `${trimmed} ${suffix}` : suffix
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'shrug',
    description: 'Append ¯\\_(ツ)_/¯ to a message',
    usage: '/shrug [message]',
    run: (args, ctx) => ctx.sendTextMessage(appendShrug(args, '¯\\_(ツ)_/¯'), ctx.replyTo).then(() => {}),
  },
  {
    name: 'tableflip',
    description: 'Append (╯°□°）╯︵ ┻━┻',
    usage: '/tableflip [message]',
    run: (args, ctx) => ctx.sendTextMessage(appendShrug(args, '(╯°□°）╯︵ ┻━┻'), ctx.replyTo).then(() => {}),
  },
  {
    name: 'unflip',
    description: 'Append ┬─┬ ノ( ゜-゜ノ)',
    usage: '/unflip [message]',
    run: (args, ctx) => ctx.sendTextMessage(appendShrug(args, '┬─┬ ノ( ゜-゜ノ)'), ctx.replyTo).then(() => {}),
  },
  {
    name: 'lenny',
    description: 'Append ( ͡° ͜ʖ ͡°)',
    usage: '/lenny [message]',
    run: (args, ctx) => ctx.sendTextMessage(appendShrug(args, '( ͡° ͜ʖ ͡°)'), ctx.replyTo).then(() => {}),
  },
  {
    name: 'me',
    description: 'Send a message as an emote / action',
    usage: '/me <action>',
    run: async (args, ctx) => {
      const action = args.trim()
      if (!ctx.roomId) throw new Error('No active room')
      if (!action) throw new Error('Usage: /me <action>')
      await ctx.client.sendEvent(ctx.roomId, 'm.room.message' as any, {
        msgtype: 'm.emote',
        body: action,
      })
    },
  },
  {
    name: 'plain',
    description: 'Send the message as literal text (bypass commands)',
    usage: '/plain <text>',
    run: async (args, ctx) => {
      if (!args.trim()) throw new Error('Usage: /plain <text>')
      await ctx.sendTextMessage(args, ctx.replyTo)
    },
  },
  {
    name: 'spoiler',
    description: 'Send the text as a spoiler',
    usage: '/spoiler <text>',
    run: async (args, ctx) => {
      const body = args.trim()
      if (!ctx.roomId) throw new Error('No active room')
      if (!body) throw new Error('Usage: /spoiler <text>')
      await ctx.client.sendEvent(ctx.roomId, 'm.room.message' as any, {
        msgtype: 'm.text',
        body: `(spoiler) ${body}`,
        format: 'org.matrix.custom.html',
        formatted_body: `<span data-mx-spoiler>${escapeHtml(body)}</span>`,
      })
    },
  },
  {
    name: 'invite',
    description: 'Invite a user to this room',
    usage: '/invite @user:server',
    run: async (args, ctx) => {
      const userId = args.trim().split(/\s+/)[0]
      if (!ctx.roomId) throw new Error('No active room')
      if (!userId) throw new Error('Usage: /invite @user:server')
      await ctx.inviteUser(ctx.roomId, userId)
      return { info: `Invited ${userId}` }
    },
  },
  {
    name: 'kick',
    description: 'Kick a user from this room',
    usage: '/kick @user:server [reason]',
    run: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const userId = parts.shift() ?? ''
      const reason = parts.join(' ').trim() || undefined
      if (!ctx.roomId) throw new Error('No active room')
      if (!userId) throw new Error('Usage: /kick @user:server [reason]')
      await ctx.kickMember(ctx.roomId, userId, reason)
      return { info: `Kicked ${userId}` }
    },
  },
  {
    name: 'ban',
    description: 'Ban a user from this room',
    usage: '/ban @user:server [reason]',
    run: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const userId = parts.shift() ?? ''
      const reason = parts.join(' ').trim() || undefined
      if (!ctx.roomId) throw new Error('No active room')
      if (!userId) throw new Error('Usage: /ban @user:server [reason]')
      await ctx.banMember(ctx.roomId, userId, reason)
      return { info: `Banned ${userId}` }
    },
  },
  {
    name: 'unban',
    description: 'Unban a user from this room',
    usage: '/unban @user:server',
    run: async (args, ctx) => {
      const userId = args.trim().split(/\s+/)[0]
      if (!ctx.roomId) throw new Error('No active room')
      if (!userId) throw new Error('Usage: /unban @user:server')
      await (ctx.client as any).unban(ctx.roomId, userId)
      return { info: `Unbanned ${userId}` }
    },
  },
  {
    name: 'join',
    aliases: ['j'],
    description: 'Join a room by alias or ID',
    usage: '/join #room:server',
    run: async (args, ctx) => {
      const target = args.trim().split(/\s+/)[0]
      if (!target) throw new Error('Usage: /join #room:server')
      await ctx.joinRoom(target)
      return { info: `Joined ${target}` }
    },
  },
  {
    name: 'part',
    aliases: ['leave'],
    description: 'Leave this room',
    run: async (_args, ctx) => {
      if (!ctx.roomId) throw new Error('No active room')
      await (ctx.client as any).leave(ctx.roomId)
    },
  },
  {
    name: 'nick',
    description: 'Set your global display name',
    usage: '/nick <name>',
    run: async (args, ctx) => {
      const name = args.trim()
      if (!name) throw new Error('Usage: /nick <name>')
      await (ctx.client as any).setDisplayName(name)
      return { info: `Display name set to "${name}"` }
    },
  },
  {
    name: 'myroomnick',
    aliases: ['roomnick'],
    description: 'Set your display name only in this room',
    usage: '/myroomnick <name>',
    run: async (args, ctx) => {
      const name = args.trim()
      if (!ctx.roomId) throw new Error('No active room')
      if (!name) throw new Error('Usage: /myroomnick <name>')
      const userId = ctx.client.getUserId() ?? ''
      if (!userId) throw new Error('Not logged in')
      const existing = ctx.client
        .getRoom(ctx.roomId)
        ?.currentState
        .getStateEvents('m.room.member', userId)
        ?.getContent() as Record<string, any> | undefined
      const content = { ...(existing ?? {}), displayname: name, membership: 'join' }
      await ctx.client.sendStateEvent(ctx.roomId, 'm.room.member' as any, content, userId)
      return { info: `Room nickname set to "${name}"` }
    },
  },
  {
    name: 'topic',
    description: 'View or set the room topic',
    usage: '/topic [new topic]',
    run: async (args, ctx) => {
      if (!ctx.roomId) throw new Error('No active room')
      const text = args.trim()
      if (!text) {
        const topic = (ctx.client
          .getRoom(ctx.roomId)
          ?.currentState
          .getStateEvents('m.room.topic', '')
          ?.getContent() as any)?.topic
        return { info: topic ? `Topic: ${topic}` : 'Topic: (none)' }
      }
      await ctx.client.sendStateEvent(ctx.roomId, 'm.room.topic' as any, { topic: text }, '')
      return { info: 'Topic updated' }
    },
  },
  {
    name: 'help',
    description: 'Show available commands',
    run: () => ({ info: 'Type / to browse commands' }),
  },
]

const BY_NAME = new Map<string, SlashCommand>()
for (const cmd of COMMANDS) {
  BY_NAME.set(cmd.name, cmd)
  for (const alias of cmd.aliases ?? []) BY_NAME.set(alias, cmd)
}

export function findCommand(name: string): SlashCommand | undefined {
  return BY_NAME.get(name.toLowerCase())
}

export function matchCommands(prefix: string): SlashCommand[] {
  const p = prefix.toLowerCase()
  return COMMANDS
    .filter(c => !c.hidden)
    .filter(c => c.name.startsWith(p) || (c.aliases?.some(a => a.startsWith(p)) ?? false))
}

/**
 * Parses input like "/cmd arg1 arg2" and returns the command + remaining args.
 * Returns null if input doesn't start with a single '/' (a leading '//' is an
 * escape meaning "send literal text" and is not a command).
 */
export function parseCommandLine(input: string): { command: SlashCommand; args: string } | null {
  if (!input.startsWith('/') || input.startsWith('//')) return null
  const body = input.slice(1)
  const spaceIdx = body.search(/\s/)
  const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx)
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1)
  const cmd = findCommand(name)
  if (!cmd) return null
  return { command: cmd, args }
}
