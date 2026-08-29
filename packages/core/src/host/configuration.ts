import type { ModelReference, PresetId } from 'yokai-protocol'
import { Context, Layer, type Option } from 'effect'

export interface Interface {
  readonly instanceId: string
  readonly model: Option.Option<ModelReference>
  readonly presetId: Option.Option<PresetId>
  readonly feedbackToolsEnabled: boolean
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/core/HostConfiguration',
) {}

export const layer = (configuration: Interface) => Layer.succeed(Service, Service.of(configuration))

export * as HostConfiguration from './configuration'
