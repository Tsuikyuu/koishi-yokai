import {
  ActivityGateValue,
  ActivityResponseMechanism,
  ActivityScoring,
  CallBudget,
  CapabilityRegistry,
  ChannelMessageBuffer,
  DirectResponseMechanism,
  HostConfiguration,
  WakeArbiter,
  WakeProposal,
} from '@yokai-internal/core'
import { MessageArchive, MessageArchiveEvent, MessageHistory } from '@yokai-internal/memory'
import { ModelReference } from 'yokai-protocol'
import { DateTime, Effect, Layer, Option, Schema } from 'effect'
import type { Context } from 'koishi'

import {
  DEFAULT_ACTIVITY_COOLDOWN_MS,
  DEFAULT_ACTIVITY_DEBOUNCE_MS,
  DEFAULT_ACTIVITY_HALF_LIFE_MS,
  DEFAULT_ACTIVITY_THRESHOLD,
  DEFAULT_BACKGROUND_DAY_CALLS,
  DEFAULT_BACKGROUND_MINUTE_CALLS,
  DEFAULT_BUDGET_TIME_ZONE,
  DEFAULT_DIRECT_DEBOUNCE_MS,
  DEFAULT_INSTANCE_ID,
  DEFAULT_MESSAGE_RETENTION_DAYS,
  DEFAULT_NORMAL_DAY_CALLS,
  DEFAULT_NORMAL_MINUTE_CALLS,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_RESERVED_DAY_CALLS,
  DEFAULT_RESERVED_MINUTE_CALLS,
  type BudgetClassConfig,
  type Config,
} from '../config'
import { HistoryCapabilityRegistration } from '../history/capabilities'
import { KoishiMessageHistoryStorage } from '../history/storage'
import { KoishiMessageArchiveStorage } from '../message-archive/storage'
import { ModelCatalogSchemaProjection } from '../model-catalog/schema-projection'
import { BuiltinResponseCapabilities } from '../response/capabilities'

const decodeModelReference = Schema.decodeUnknownEffect(ModelReference)

const decodeConfiguration = Effect.fn('YokaiRuntime.decodeConfiguration')(function* (
  config: Config,
) {
  const model =
    config.model === undefined
      ? Option.none<ModelReference>()
      : Option.some(yield* decodeModelReference(config.model))

  return HostConfiguration.Service.of({
    instanceId: config.instanceId === undefined ? DEFAULT_INSTANCE_ID : config.instanceId,
    model,
    feedbackToolsEnabled: config.feedbackToolsEnabled,
  })
})

const configurationLayer = (config: Config) =>
  Layer.effect(HostConfiguration.Service, decodeConfiguration(config))

const configuredNumber = (value: number | undefined, fallback: number): number =>
  value === undefined ? fallback : value

const configuredBudgetClass = (
  configured: BudgetClassConfig | undefined,
  minute: number,
  day: number,
): CallBudget.WindowLimits =>
  CallBudget.WindowLimits.make({
    minute: CallBudget.CallCount.make(
      configuredNumber(configured === undefined ? undefined : configured.minute, minute),
    ),
    day: CallBudget.CallCount.make(
      configuredNumber(configured === undefined ? undefined : configured.day, day),
    ),
  })

const callBudgetLayer = (config: Config) => {
  const configured = config.callBudget
  const timeZone =
    configured === undefined || configured.timeZone === undefined
      ? DEFAULT_BUDGET_TIME_ZONE
      : configured.timeZone
  return Layer.unwrap(
    DateTime.zoneMakeNamedEffect(timeZone).pipe(
      Effect.map((zone) =>
        CallBudget.layer({
          timeZone: zone,
          limits: CallBudget.ClassifiedLimits.make({
            reserved: configuredBudgetClass(
              configured === undefined ? undefined : configured.reserved,
              DEFAULT_RESERVED_MINUTE_CALLS,
              DEFAULT_RESERVED_DAY_CALLS,
            ),
            normal: configuredBudgetClass(
              configured === undefined ? undefined : configured.normal,
              DEFAULT_NORMAL_MINUTE_CALLS,
              DEFAULT_NORMAL_DAY_CALLS,
            ),
            background: configuredBudgetClass(
              configured === undefined ? undefined : configured.background,
              DEFAULT_BACKGROUND_MINUTE_CALLS,
              DEFAULT_BACKGROUND_DAY_CALLS,
            ),
          }),
        }),
      ),
    ),
  )
}

const wakeServicesLayer = (config: Config) => {
  const configured = config.wake
  const directDebounceMs = configuredNumber(
    configured === undefined ? undefined : configured.directDebounceMs,
    DEFAULT_DIRECT_DEBOUNCE_MS,
  )
  const activityDebounceMs = configuredNumber(
    configured === undefined ? undefined : configured.activityDebounceMs,
    DEFAULT_ACTIVITY_DEBOUNCE_MS,
  )
  const cooldownMs = configuredNumber(
    configured === undefined ? undefined : configured.cooldownMs,
    DEFAULT_ACTIVITY_COOLDOWN_MS,
  )
  const activityHalfLifeMs = configuredNumber(
    configured === undefined ? undefined : configured.activityHalfLifeMs,
    DEFAULT_ACTIVITY_HALF_LIFE_MS,
  )
  const activityThreshold = configuredNumber(
    configured === undefined ? undefined : configured.activityThreshold,
    DEFAULT_ACTIVITY_THRESHOLD,
  )
  const relevanceThreshold = configuredNumber(
    configured === undefined ? undefined : configured.relevanceThreshold,
    DEFAULT_RELEVANCE_THRESHOLD,
  )

  const budgetServices = callBudgetLayer(config)
  const arbiterServices = WakeArbiter.layer({
    cooldownMs: WakeProposal.DurationMilliseconds.make(cooldownMs),
  }).pipe(Layer.provideMerge(budgetServices))
  const activityServices = ActivityResponseMechanism.layer({
    debounceMs: WakeProposal.DurationMilliseconds.make(activityDebounceMs),
    proposalTtlMs: WakeProposal.DurationMilliseconds.make(activityDebounceMs + 12_000),
    activityParameters: ActivityScoring.Parameters.make({
      ...ActivityScoring.DEFAULT_PARAMETERS,
      halfLifeMs: ActivityGateValue.PositiveMilliseconds.make(activityHalfLifeMs),
    }),
    activityThreshold: ActivityGateValue.Score.make(activityThreshold),
    relevanceThreshold: ActivityGateValue.Score.make(relevanceThreshold),
  }).pipe(Layer.provideMerge(arbiterServices))
  const direct = DirectResponseMechanism.layer({
    debounceMs: WakeProposal.DurationMilliseconds.make(directDebounceMs),
    proposalTtlMs: WakeProposal.DurationMilliseconds.make(directDebounceMs + 9_500),
  })
  return Layer.merge(direct, activityServices)
}

const decodeMessageArchiveOptions = Effect.fn('YokaiRuntime.decodeMessageArchiveOptions')(
  function* (config: Config) {
    const instanceId = yield* Schema.decodeUnknownEffect(MessageArchiveEvent.InstanceId)(
      config.instanceId === undefined ? DEFAULT_INSTANCE_ID : config.instanceId,
    )
    const retentionDays = yield* Schema.decodeUnknownEffect(MessageArchiveEvent.RetentionDays)(
      config.messageRetentionDays === undefined
        ? DEFAULT_MESSAGE_RETENTION_DAYS
        : config.messageRetentionDays,
    )
    return {
      instanceId,
      retentionDays,
      cleanupInterval: MessageArchive.DEFAULT_CLEANUP_INTERVAL,
    } satisfies MessageArchive.Options
  },
)

const messageArchiveLayer = (config: Config, ctx: Context) =>
  Layer.unwrap(
    decodeMessageArchiveOptions(config).pipe(
      Effect.map((options) => MessageArchive.layer(options)),
    ),
  ).pipe(Layer.provide(KoishiMessageArchiveStorage.layer(ctx)))

const messageHistoryLayer = (config: Config, ctx: Context) =>
  Layer.unwrap(
    decodeMessageArchiveOptions(config).pipe(
      Effect.map((options) => MessageHistory.layer(options.instanceId)),
    ),
  ).pipe(Layer.provide(KoishiMessageHistoryStorage.layer(ctx)))

export const makeLayer = (config: Config, ctx: Context) => {
  const hostServices = Layer.mergeAll(
    CapabilityRegistry.layer,
    ChannelMessageBuffer.layer,
    configurationLayer(config),
    wakeServicesLayer(config),
  )
  const archiveServices = Layer.merge(
    messageArchiveLayer(config, ctx),
    messageHistoryLayer(config, ctx),
  )
  const services = Layer.merge(hostServices, archiveServices)
  const servicesWithBuiltins = HistoryCapabilityRegistration.layer.pipe(
    Layer.provideMerge(services),
  )
  const servicesWithAllBuiltins = BuiltinResponseCapabilities.layer.pipe(
    Layer.provideMerge(servicesWithBuiltins),
  )
  return ModelCatalogSchemaProjection.layer(ctx, config).pipe(
    Layer.provideMerge(servicesWithAllBuiltins),
  )
}

export * as YokaiRuntimeLayer from './layer'
