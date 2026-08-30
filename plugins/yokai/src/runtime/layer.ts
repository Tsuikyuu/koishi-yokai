import { resolve } from 'node:path'

import {
  ActivityGateValue,
  ActivityResponseMechanism,
  BackgroundTasks,
  ActivityScoring,
  CallBudget,
  CapabilityRegistry,
  ChannelMessageBuffer,
  DirectResponseMechanism,
  EngagementLease,
  HostConfiguration,
  PresetRegistry,
  RoleState,
  ThreadTracker,
  WakeArbiter,
  WakeProposal,
} from '@yokai-internal/core'
import {
  MessageArchive,
  MessageArchiveEvent,
  MessageHistory,
  Notebook,
  NotebookModel,
} from '@yokai-internal/memory'
import { RoleStateModel } from '@yokai-internal/mind'
import { ModelReference, PresetId } from 'yokai-protocol'
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
  DEFAULT_ENGAGEMENT_ENABLED,
  DEFAULT_ENGAGEMENT_IDLE_TTL_MS,
  DEFAULT_ENGAGEMENT_MAX_DURATION_MS,
  DEFAULT_ENGAGEMENT_MAX_ROUNDS,
  DEFAULT_INSTANCE_ID,
  DEFAULT_MESSAGE_RETENTION_DAYS,
  DEFAULT_NOTEBOOK_EXPIRATION_DAYS,
  DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY,
  DEFAULT_NOTEBOOK_RECALL_LIMIT,
  DEFAULT_NORMAL_DAY_CALLS,
  DEFAULT_NORMAL_MINUTE_CALLS,
  DEFAULT_PRESET_RELOAD_DEBOUNCE_MS,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_RESERVED_DAY_CALLS,
  DEFAULT_RESERVED_MINUTE_CALLS,
  DEFAULT_STATE_ENERGY_RECOVERY_HALF_LIFE_MS,
  DEFAULT_STATE_MAX_INTERACTION_DELTA,
  DEFAULT_STATE_MOOD_HALF_LIFE_MS,
  DEFAULT_STATE_PARTICIPATION_HALF_LIFE_MS,
  type BudgetClassConfig,
  type Config,
} from '../config'
import { HistoryCapabilityRegistration } from '../history/capabilities'
import { KoishiMessageHistoryStorage } from '../history/storage'
import { KoishiMessageArchiveStorage } from '../message-archive/storage'
import { ModelCatalogSchemaProjection } from '../model-catalog/schema-projection'
import { NotebookCapabilityRegistration } from '../notebook/capabilities'
import { KoishiNotebookStorage } from '../notebook/index'
import { FilePresetSource } from '../preset/file-source'
import { FilePresetStore } from '../preset/file-store'
import { PresetEvents } from '../preset/events'
import { KoishiRoleStateStorage } from '../role-state/index'
import { BuiltinResponseCapabilities } from '../response/capabilities'

const decodeModelReference = Schema.decodeUnknownEffect(ModelReference)
const decodePresetId = Schema.decodeUnknownEffect(PresetId)

const decodeConfiguration = Effect.fn('YokaiRuntime.decodeConfiguration')(function* (
  config: Config,
) {
  const model =
    config.model === undefined
      ? Option.none<ModelReference>()
      : Option.some(yield* decodeModelReference(config.model))
  const presetId =
    config.presetId === undefined
      ? Option.none<PresetId>()
      : Option.some(yield* decodePresetId(config.presetId))

  return HostConfiguration.Service.of({
    instanceId: config.instanceId === undefined ? DEFAULT_INSTANCE_ID : config.instanceId,
    model,
    presetId,
    feedbackToolsEnabled: config.feedbackToolsEnabled,
  })
})

const configurationLayer = (config: Config) =>
  Layer.effect(HostConfiguration.Service, decodeConfiguration(config))

const configuredNumber = (value: number | undefined, fallback: number): number =>
  value === undefined ? fallback : value

const decodeEngagementOptions = Effect.fn('YokaiRuntime.decodeEngagementOptions')(function* (
  config: Config,
  directDebounceMs: number,
) {
  const configured = config.engagement
  return yield* Schema.decodeUnknownEffect(EngagementLease.Options)({
    enabled:
      configured === undefined || configured.enabled === undefined
        ? DEFAULT_ENGAGEMENT_ENABLED
        : configured.enabled,
    idleTtlMs: configuredNumber(
      configured === undefined ? undefined : configured.idleTtlMs,
      DEFAULT_ENGAGEMENT_IDLE_TTL_MS,
    ),
    maxDurationMs: configuredNumber(
      configured === undefined ? undefined : configured.maxDurationMs,
      DEFAULT_ENGAGEMENT_MAX_DURATION_MS,
    ),
    maxRounds: configuredNumber(
      configured === undefined ? undefined : configured.maxRounds,
      DEFAULT_ENGAGEMENT_MAX_ROUNDS,
    ),
    debounceMs: directDebounceMs,
    proposalTtlMs: directDebounceMs + 9_500,
  })
})

const stateParameters = (config: Config): RoleStateModel.Parameters => {
  const configured = config.state
  const defaults = RoleStateModel.defaultParameters()
  const maximumDelta = configuredNumber(
    configured === undefined ? undefined : configured.maxInteractionDelta,
    DEFAULT_STATE_MAX_INTERACTION_DELTA,
  )
  return RoleStateModel.Parameters.make({
    moodHalfLifeMs: RoleStateModel.DecayHalfLifeMilliseconds.make(
      configuredNumber(
        configured === undefined ? undefined : configured.moodHalfLifeMs,
        DEFAULT_STATE_MOOD_HALF_LIFE_MS,
      ),
    ),
    recentParticipationHalfLifeMs: RoleStateModel.DecayHalfLifeMilliseconds.make(
      configuredNumber(
        configured === undefined ? undefined : configured.participationHalfLifeMs,
        DEFAULT_STATE_PARTICIPATION_HALF_LIFE_MS,
      ),
    ),
    socialEnergyRecoveryHalfLifeMs: RoleStateModel.DecayHalfLifeMilliseconds.make(
      configuredNumber(
        configured === undefined ? undefined : configured.energyRecoveryHalfLifeMs,
        DEFAULT_STATE_ENERGY_RECOVERY_HALF_LIFE_MS,
      ),
    ),
    maxMoodValenceDelta: RoleStateModel.Level.make(
      Math.min(defaults.maxMoodValenceDelta, maximumDelta),
    ),
    maxMoodArousalDelta: RoleStateModel.Level.make(
      Math.min(defaults.maxMoodArousalDelta, maximumDelta),
    ),
    maxSocialEnergyDelta: RoleStateModel.Level.make(
      Math.min(defaults.maxSocialEnergyDelta, maximumDelta),
    ),
    maxRecentParticipationDelta: RoleStateModel.Level.make(
      Math.min(defaults.maxRecentParticipationDelta, maximumDelta),
    ),
    maxFamiliarityDelta: RoleStateModel.Level.make(
      Math.min(defaults.maxFamiliarityDelta, maximumDelta),
    ),
    maxInteractionDepthDelta: RoleStateModel.Level.make(
      Math.min(defaults.maxInteractionDepthDelta, maximumDelta),
    ),
  })
}

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
  const engagement = Layer.unwrap(
    decodeEngagementOptions(config, directDebounceMs).pipe(
      Effect.map((options) => EngagementLease.layer(options)),
    ),
  )
  return Layer.mergeAll(direct, engagement, activityServices)
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

const decodeNotebookOptions = Effect.fn('YokaiRuntime.decodeNotebookOptions')(function* (
  config: Config,
) {
  const configured = config.notebook
  const instanceId = yield* Schema.decodeUnknownEffect(MessageArchiveEvent.InstanceId)(
    config.instanceId === undefined ? DEFAULT_INSTANCE_ID : config.instanceId,
  )
  const maxNotesPerReply = yield* Schema.decodeUnknownEffect(NotebookModel.NotesPerReply)(
    configuredNumber(
      configured === undefined ? undefined : configured.maxNotesPerReply,
      DEFAULT_NOTEBOOK_MAX_NOTES_PER_REPLY,
    ),
  )
  const recallLimit = yield* Schema.decodeUnknownEffect(NotebookModel.RecallLimit)(
    configuredNumber(
      configured === undefined ? undefined : configured.recallLimit,
      DEFAULT_NOTEBOOK_RECALL_LIMIT,
    ),
  )
  const defaultExpirationDays = yield* Schema.decodeUnknownEffect(NotebookModel.ExpirationDays)(
    configuredNumber(
      configured === undefined ? undefined : configured.defaultExpirationDays,
      DEFAULT_NOTEBOOK_EXPIRATION_DAYS,
    ),
  )

  return {
    instanceId,
    maxNotesPerReply,
    recallLimit,
    defaultExpirationDays: Option.some(defaultExpirationDays),
  } satisfies Notebook.Options
})

const notebookLayer = (config: Config, ctx: Context) =>
  Layer.unwrap(
    decodeNotebookOptions(config).pipe(Effect.map((options) => Notebook.layer(options))),
  ).pipe(Layer.provide(KoishiNotebookStorage.layer(ctx)))

const notebookCapabilitiesLayer = (config: Config) =>
  Layer.unwrap(
    decodeNotebookOptions(config).pipe(
      Effect.map((options) => NotebookCapabilityRegistration.layer(options)),
    ),
  )

export const makeLayer = (config: Config, ctx: Context) => {
  const roleStateServices = RoleState.layer({ parameters: stateParameters(config) }).pipe(
    Layer.provide(KoishiRoleStateStorage.layer(ctx)),
  )
  const hostServices = Layer.mergeAll(
    BackgroundTasks.layer,
    CapabilityRegistry.layer,
    ChannelMessageBuffer.layer,
    configurationLayer(config),
    PresetRegistry.layer,
    roleStateServices,
    ThreadTracker.layer,
    wakeServicesLayer(config),
  )
  const presetDirectory =
    config.presetDirectory === undefined
      ? Option.none<string>()
      : Option.some(resolve(ctx.baseDir, config.presetDirectory))
  const filePresetSource = FilePresetSource.layer({
    directory: presetDirectory,
    debounceMs: configuredNumber(config.presetReloadDebounceMs, DEFAULT_PRESET_RELOAD_DEBOUNCE_MS),
  }).pipe(Layer.provide(FilePresetStore.layer))
  const presetIntegrations = Layer.merge(filePresetSource, PresetEvents.layer(ctx))
  const archiveServices = Layer.merge(
    messageArchiveLayer(config, ctx),
    messageHistoryLayer(config, ctx),
  )
  const notebookServices = notebookLayer(config, ctx).pipe(Layer.provideMerge(archiveServices))
  const services = Layer.merge(hostServices, notebookServices)
  const servicesWithBuiltins = HistoryCapabilityRegistration.layer.pipe(
    Layer.provideMerge(services),
  )
  const servicesWithNotebook = notebookCapabilitiesLayer(config).pipe(
    Layer.provideMerge(servicesWithBuiltins),
  )
  const servicesWithAllBuiltins = BuiltinResponseCapabilities.layer.pipe(
    Layer.provideMerge(servicesWithNotebook),
  )
  const servicesWithPresets = presetIntegrations.pipe(Layer.provideMerge(servicesWithAllBuiltins))
  return ModelCatalogSchemaProjection.layer(ctx, config).pipe(
    Layer.provideMerge(servicesWithPresets),
  )
}

export * as YokaiRuntimeLayer from './layer'
