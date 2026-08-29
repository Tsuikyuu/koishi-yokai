import { Context, Effect, Option, Schema } from 'effect'

export class SendError extends Schema.TaggedError<SendError>('@yokai/core/HostSession.SendError')(
  'HostSessionSendError',
  {
    cause: Schema.Defect(),
  },
) {}

export type SendText = (
  content: string,
  replyToMessageId: Option.Option<string>,
) => Effect.Effect<ReadonlyArray<string>, SendError>

/** Koishi-independent input frozen from one host Session at the plugin boundary. */
export interface Interface {
  readonly eventType: string
  readonly platform: string
  readonly selfId: string
  readonly timestamp: number
  readonly userId: Option.Option<string>
  readonly channelId: Option.Option<string>
  readonly guildId: Option.Option<string>
  readonly messageId: Option.Option<string>
  readonly content: Option.Option<string>
  readonly isDirect: boolean
  readonly sendText: SendText
}

export class Service extends Context.Service<Service, Interface>()('@yokai/core/HostSession') {}

export * as HostSession from './session'
