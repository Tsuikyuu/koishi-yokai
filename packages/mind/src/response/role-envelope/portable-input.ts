import { Effect, Schema } from 'effect'
import type {
  PortableObjectProperty,
  PortableObjectSchema,
  PortableValueSchema,
} from 'yokai-protocol'

import { ParseError } from './schema'
import { plainText, structuralChildren, type XmlElement } from './xml'

type JsonRecord = Readonly<Record<string, Schema.Json>>
type JsonEntry = readonly [string, Schema.Json]

const invalidInput = (): ParseError => new ParseError({ reason: 'invalid-action-input' })

const invalidTemplate = (): ParseError => new ParseError({ reason: 'invalid-action' })

const finiteNumberPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/

const withinBounds = (value: number, minimum?: number, maximum?: number): boolean =>
  (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum)

const decodeLeaf = (
  element: XmlElement,
  schema: Exclude<PortableValueSchema, PortableObjectSchema | { readonly _tag: 'Array' }>,
): Effect.Effect<Schema.Json, ParseError> => {
  const value = plainText(element)
  if (value === undefined) return Effect.fail(invalidInput())

  switch (schema._tag) {
    case 'String':
      return Effect.succeed(value)
    case 'StringEnum':
      return schema.values.includes(value) ? Effect.succeed(value) : Effect.fail(invalidInput())
    case 'Boolean':
      return value === 'true'
        ? Effect.succeed(true)
        : value === 'false'
          ? Effect.succeed(false)
          : Effect.fail(invalidInput())
    case 'Number': {
      if (!finiteNumberPattern.test(value)) return Effect.fail(invalidInput())
      const decoded = Number(value)
      return Number.isFinite(decoded) && withinBounds(decoded, schema.minimum, schema.maximum)
        ? Effect.succeed(decoded)
        : Effect.fail(invalidInput())
    }
    case 'Integer': {
      if (!integerPattern.test(value)) return Effect.fail(invalidInput())
      const decoded = Number(value)
      return Number.isSafeInteger(decoded) && withinBounds(decoded, schema.minimum, schema.maximum)
        ? Effect.succeed(decoded)
        : Effect.fail(invalidInput())
    }
  }
}

const decodeValue = (
  element: XmlElement,
  schema: PortableValueSchema,
): Effect.Effect<Schema.Json, ParseError> => {
  if (element.attributes.length !== 0) return Effect.fail(invalidInput())

  switch (schema._tag) {
    case 'Object':
      return decodeObject(element, schema)
    case 'Array': {
      const children = structuralChildren(element)
      if (children === undefined || children.some((child) => child.name !== 'item')) {
        return Effect.fail(invalidInput())
      }
      if (children.length < schema.minItems || children.length > schema.maxItems) {
        return Effect.fail(invalidInput())
      }
      return Effect.forEach(children, (child) => decodeValue(child, schema.items))
    }
    default:
      return decodeLeaf(element, schema)
  }
}

const decodeProperties = Effect.fn('RoleResponseEnvelope.decodeProperties')(function* (
  properties: ReadonlyArray<PortableObjectProperty>,
  elements: ReadonlyArray<XmlElement>,
  propertyIndex = 0,
  elementIndex = 0,
  entries: ReadonlyArray<JsonEntry> = [],
): Effect.fn.Return<JsonRecord, ParseError> {
  const property = properties[propertyIndex]
  const element = elements[elementIndex]

  if (property === undefined) {
    if (element !== undefined) return yield* Effect.fail(invalidInput())
    return yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
      Object.fromEntries(entries),
    ).pipe(Effect.mapError(invalidInput))
  }

  if (element === undefined) {
    if (properties.slice(propertyIndex).some((candidate) => candidate.required)) {
      return yield* Effect.fail(invalidInput())
    }
    return yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
      Object.fromEntries(entries),
    ).pipe(Effect.mapError(invalidInput))
  }

  if (element.name === property.name) {
    const value = yield* decodeValue(element, property.schema)
    return yield* decodeProperties(properties, elements, propertyIndex + 1, elementIndex + 1, [
      ...entries,
      [property.name, value] as const,
    ])
  }

  if (property.required) return yield* Effect.fail(invalidInput())
  return yield* decodeProperties(properties, elements, propertyIndex + 1, elementIndex, entries)
})

const decodeObject = (
  element: XmlElement,
  schema: PortableObjectSchema,
): Effect.Effect<JsonRecord, ParseError> => {
  const children = structuralChildren(element)
  return children === undefined
    ? Effect.fail(invalidInput())
    : decodeProperties(schema.properties, children)
}

export const decodeActionInput = (
  action: XmlElement,
  schema: PortableObjectSchema,
): Effect.Effect<JsonRecord, ParseError> => decodeObject(action, schema)

const validateTemplateValue = (
  element: XmlElement,
  schema: PortableValueSchema,
): Effect.Effect<void, ParseError> => {
  if (element.attributes.length !== 0) return Effect.fail(invalidTemplate())

  switch (schema._tag) {
    case 'Object':
      return validateTemplateObject(element, schema)
    case 'Array': {
      if (schema.maxItems < 1) return Effect.fail(invalidTemplate())
      const children = structuralChildren(element)
      if (children === undefined || children.length !== 1) {
        return Effect.fail(invalidTemplate())
      }
      const item = children[0]
      if (item === undefined || item.name !== 'item') return Effect.fail(invalidTemplate())
      return validateTemplateValue(item, schema.items)
    }
    default: {
      const placeholder = plainText(element)
      return placeholder !== undefined &&
        placeholder.length > 0 &&
        placeholder === placeholder.trim()
        ? Effect.void
        : Effect.fail(invalidTemplate())
    }
  }
}

const validateTemplateProperties = Effect.fn('RoleResponseEnvelope.validateTemplateProperties')(
  function* (
    properties: ReadonlyArray<PortableObjectProperty>,
    elements: ReadonlyArray<XmlElement>,
  ): Effect.fn.Return<void, ParseError> {
    if (properties.length !== elements.length) {
      return yield* Effect.fail(invalidTemplate())
    }

    for (let index = 0; index < properties.length; index += 1) {
      const property = properties[index]
      const element = elements[index]
      if (property === undefined || element === undefined || property.name !== element.name) {
        return yield* Effect.fail(invalidTemplate())
      }
      yield* validateTemplateValue(element, property.schema)
    }
  },
)

const validateTemplateObject = (
  element: XmlElement,
  schema: PortableObjectSchema,
): Effect.Effect<void, ParseError> => {
  const children = structuralChildren(element)
  return children === undefined
    ? Effect.fail(invalidTemplate())
    : validateTemplateProperties(schema.properties, children)
}

export const validateTemplateInput = (
  action: XmlElement,
  schema: PortableObjectSchema,
): Effect.Effect<void, ParseError> => validateTemplateObject(action, schema)
