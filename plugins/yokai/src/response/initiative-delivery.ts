import {
  HostConfiguration,
  HostModelSelection,
  HostSession,
  InitiativeDelivery,
  PresetRegistry,
  WakeArbiter,
  WakeTurn,
} from '@yokai-internal/core'
import { Effect, Layer, Option } from 'effect'
import { h, type Context, Universal } from 'koishi'

const matchingBot = (ctx: Context, target: InitiativeDelivery.Request['target']) =>
  ctx.bots.find(
    (candidate) =>
      candidate.platform === target.scope.platform &&
      candidate.selfId === target.selfId &&
      candidate.status === Universal.Status.ONLINE,
  )

const missingBot = (request: InitiativeDelivery.Request): InitiativeDelivery.DispatchError =>
  new InitiativeDelivery.DispatchError({
    scopeId: request.proposal.scopeId,
    cause: new Error(
      `No active bot matched ${request.target.scope.platform}:${request.target.selfId} for initiative delivery`,
    ),
  })

export const layer = (ctx: Context) =>
  Layer.effect(
    InitiativeDelivery.Service,
    Effect.gen(function* () {
      const environment = yield* Effect.context<WakeTurn.Services>()

      const turnDependenciesAvailable = Effect.gen(function* () {
        const configuration = yield* HostConfiguration.Service
        const presets = yield* PresetRegistry.Service
        const presetAvailable = yield* Option.match(configuration.presetId, {
          onNone: () => Effect.succeed(true),
          onSome: (presetId) => presets.snapshot(presetId).pipe(Effect.map(Option.isSome)),
        })
        if (!presetAvailable) return false
        return Option.isSome(yield* HostModelSelection.resolve().pipe(Effect.option))
      })

      const dispatch = Effect.fn('KoishiInitiativeDelivery.dispatch')(function* (
        request: InitiativeDelivery.Request,
      ) {
        const target = request.target
        const bot = matchingBot(ctx, target)
        if (bot === undefined) return yield* Effect.fail(missingBot(request))

        const sendText: HostSession.SendText = (content, quoteMessageId) =>
          Effect.tryPromise({
            try: () =>
              bot.sendMessage(
                target.scope.channelId,
                Option.match(quoteMessageId, {
                  onNone: () => h.text(content),
                  onSome: (messageId) => [h.quote(messageId), h.text(content)],
                }),
                target.scope.guildId,
              ),
            catch: (cause) => new HostSession.SendError({ cause }),
          })

        const arbiter = yield* WakeArbiter.Service
        const executeTurn = yield* WakeTurn.makeExecutor(sendText)
        const outcome = yield* arbiter.submitWithAdmission(
          request.proposal,
          request.admission,
          executeTurn,
        )
        yield* Effect.logDebug('KoishiInitiativeDelivery.completed').pipe(
          Effect.annotateLogs({
            scopeId: request.proposal.scopeId,
            outcome: outcome._tag,
          }),
        )
        return outcome
      })

      return InitiativeDelivery.Service.of({
        isAvailable: (target) =>
          matchingBot(ctx, target) === undefined
            ? Effect.succeed(false)
            : turnDependenciesAvailable.pipe(Effect.provide(environment)),
        dispatch: (request) => dispatch(request).pipe(Effect.provide(environment)),
      })
    }),
  )

export * as KoishiInitiativeDelivery from './initiative-delivery'
