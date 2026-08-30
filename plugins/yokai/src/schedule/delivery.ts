import {
  HostConfiguration,
  HostModelSelection,
  HostSession,
  PresetRegistry,
  ScheduledDelivery,
  WakeArbiter,
  WakeTurn,
} from '@yokai-internal/core'
import { Effect, Layer, Option } from 'effect'
import { h, type Context, Universal } from 'koishi'

const matchingBot = (ctx: Context, task: ScheduledDelivery.Request['task']) =>
  ctx.bots.find(
    (candidate) =>
      candidate.platform === task.platform &&
      candidate.selfId === task.selfId &&
      candidate.status === Universal.Status.ONLINE,
  )

const missingBot = (request: ScheduledDelivery.Request): ScheduledDelivery.DispatchError =>
  new ScheduledDelivery.DispatchError({
    scheduleId: request.task.scheduleId,
    occurrence: request.task.occurrence,
    cause: new Error(
      `No active bot matched ${request.task.platform}:${request.task.selfId} for scheduled delivery`,
    ),
  })

export const layer = (ctx: Context) =>
  Layer.effect(
    ScheduledDelivery.Service,
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

      const dispatch = Effect.fn('KoishiScheduledDelivery.dispatch')(function* (
        request: ScheduledDelivery.Request,
      ) {
        const task = request.task
        const bot = matchingBot(ctx, task)
        if (bot === undefined) return yield* Effect.fail(missingBot(request))

        const sendText: HostSession.SendText = (content, quoteMessageId) =>
          Effect.tryPromise({
            try: () =>
              bot.sendMessage(
                task.channelId,
                Option.match(quoteMessageId, {
                  onNone: () => h.text(content),
                  onSome: (messageId) => [h.quote(messageId), h.text(content)],
                }),
                task.guildId,
              ),
            catch: (cause) => new HostSession.SendError({ cause }),
          })

        const arbiter = yield* WakeArbiter.Service
        const executeTurn = yield* WakeTurn.makeExecutor(sendText)
        const outcome = yield* arbiter.submit(request.proposal, executeTurn)
        yield* Effect.logDebug('KoishiScheduledDelivery.completed').pipe(
          Effect.annotateLogs({
            scheduleId: task.scheduleId,
            occurrence: task.occurrence,
            outcome: outcome._tag,
          }),
        )
      })

      return ScheduledDelivery.Service.of({
        isAvailable: (task) =>
          matchingBot(ctx, task) === undefined
            ? Effect.succeed(false)
            : turnDependenciesAvailable.pipe(Effect.provide(environment)),
        dispatch: (request) => dispatch(request).pipe(Effect.provide(environment)),
      })
    }),
  )

export * as KoishiScheduledDelivery from './delivery'
