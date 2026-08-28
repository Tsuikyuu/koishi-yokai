import { PresetRegistry } from '@yokai-internal/core'
import { Effect, Layer, Stream } from 'effect'
import type { Context } from 'koishi'

export const layer = (ctx: Context) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const presets = yield* PresetRegistry.Service
      yield* presets.updates.pipe(
        Stream.runForEach((snapshot) =>
          Effect.sync(() => ctx.emit('yokai/preset-updated', snapshot)),
        ),
        Effect.forkScoped,
      )
    }),
  )

export * as PresetEvents from './events'
