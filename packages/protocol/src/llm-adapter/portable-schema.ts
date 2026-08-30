import { Schema } from 'effect'

export const MAX_PORTABLE_SCHEMA_DEPTH = 5
export const MAX_PORTABLE_SCHEMA_PROPERTIES = 100
export const MAX_PORTABLE_ARRAY_ITEMS = 128
export const MAX_PORTABLE_ENUM_VALUES = 64
export const MAX_PORTABLE_ENUM_VALUE_LENGTH = 256
export const MAX_PORTABLE_PROPERTY_NAME_LENGTH = 128
export const MAX_PORTABLE_DESCRIPTION_LENGTH = 1024

const PortableDescription = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PORTABLE_DESCRIPTION_LENGTH),
)

export const PortablePropertyName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PORTABLE_PROPERTY_NAME_LENGTH),
)

export type PortablePropertyName = typeof PortablePropertyName.Type

const PortableArrayBound = Schema.Natural.check(
  Schema.isLessThanOrEqualTo(MAX_PORTABLE_ARRAY_ITEMS),
)

const PortableEnumValue = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PORTABLE_ENUM_VALUE_LENGTH),
)

const PortableEnumValues = Schema.NonEmptyArray(PortableEnumValue).check(
  Schema.isMaxLength(MAX_PORTABLE_ENUM_VALUES),
  Schema.isUnique(),
)

export interface PortableStringSchema {
  readonly _tag: 'String'
  readonly description?: string
}

export interface PortableStringSchemaEncoded {
  readonly _tag: 'String'
  readonly description?: string
}

export interface PortableNumberSchema {
  readonly _tag: 'Number'
  readonly description?: string
  readonly minimum?: number
  readonly maximum?: number
}

export interface PortableNumberSchemaEncoded {
  readonly _tag: 'Number'
  readonly description?: string
  readonly minimum?: number
  readonly maximum?: number
}

export interface PortableIntegerSchema {
  readonly _tag: 'Integer'
  readonly description?: string
  readonly minimum?: number
  readonly maximum?: number
}

export interface PortableIntegerSchemaEncoded {
  readonly _tag: 'Integer'
  readonly description?: string
  readonly minimum?: number
  readonly maximum?: number
}

export interface PortableBooleanSchema {
  readonly _tag: 'Boolean'
  readonly description?: string
}

export interface PortableBooleanSchemaEncoded {
  readonly _tag: 'Boolean'
  readonly description?: string
}

export interface PortableStringEnumSchema {
  readonly _tag: 'StringEnum'
  readonly description?: string
  readonly values: readonly [string, ...Array<string>]
}

export interface PortableStringEnumSchemaEncoded {
  readonly _tag: 'StringEnum'
  readonly description?: string
  readonly values: readonly [string, ...Array<string>]
}

export interface PortableArraySchema {
  readonly _tag: 'Array'
  readonly description?: string
  readonly items: PortableValueSchema
  readonly minItems: number
  readonly maxItems: number
}

export interface PortableArraySchemaEncoded {
  readonly _tag: 'Array'
  readonly description?: string
  readonly items: PortableValueSchemaEncoded
  readonly minItems: number
  readonly maxItems: number
}

export interface PortableObjectProperty {
  readonly name: PortablePropertyName
  readonly required: boolean
  readonly schema: PortableValueSchema
}

export interface PortableObjectPropertyEncoded {
  readonly name: string
  readonly required: boolean
  readonly schema: PortableValueSchemaEncoded
}

export interface PortableObjectSchema {
  readonly _tag: 'Object'
  readonly description?: string
  readonly properties: ReadonlyArray<PortableObjectProperty>
}

export interface PortableObjectSchemaEncoded {
  readonly _tag: 'Object'
  readonly description?: string
  readonly properties: ReadonlyArray<PortableObjectPropertyEncoded>
}

export type PortableValueSchema =
  | PortableStringSchema
  | PortableNumberSchema
  | PortableIntegerSchema
  | PortableBooleanSchema
  | PortableStringEnumSchema
  | PortableArraySchema
  | PortableObjectSchema

export type PortableValueSchemaEncoded =
  | PortableStringSchemaEncoded
  | PortableNumberSchemaEncoded
  | PortableIntegerSchemaEncoded
  | PortableBooleanSchemaEncoded
  | PortableStringEnumSchemaEncoded
  | PortableArraySchemaEncoded
  | PortableObjectSchemaEncoded

export const PortableStringSchema: Schema.Codec<PortableStringSchema, PortableStringSchemaEncoded> =
  Schema.TaggedStruct('String', {
    description: Schema.optionalKey(PortableDescription),
  })

const validNumericBounds = (minimum?: number, maximum?: number) =>
  minimum === undefined || maximum === undefined || minimum <= maximum

export const PortableNumberSchema: Schema.Codec<PortableNumberSchema, PortableNumberSchemaEncoded> =
  Schema.TaggedStruct('Number', {
    description: Schema.optionalKey(PortableDescription),
    minimum: Schema.optionalKey(Schema.Finite),
    maximum: Schema.optionalKey(Schema.Finite),
  }).check(
    Schema.makeFilter((schema: PortableNumberSchema) =>
      validNumericBounds(schema.minimum, schema.maximum)
        ? true
        : 'Expected numeric minimum <= maximum',
    ),
  )

export const PortableIntegerSchema: Schema.Codec<
  PortableIntegerSchema,
  PortableIntegerSchemaEncoded
> = Schema.TaggedStruct('Integer', {
  description: Schema.optionalKey(PortableDescription),
  minimum: Schema.optionalKey(Schema.Int),
  maximum: Schema.optionalKey(Schema.Int),
}).check(
  Schema.makeFilter((schema: PortableIntegerSchema) =>
    validNumericBounds(schema.minimum, schema.maximum)
      ? true
      : 'Expected integer minimum <= maximum',
  ),
)

export const PortableBooleanSchema: Schema.Codec<
  PortableBooleanSchema,
  PortableBooleanSchemaEncoded
> = Schema.TaggedStruct('Boolean', {
  description: Schema.optionalKey(PortableDescription),
})

export const PortableStringEnumSchema: Schema.Codec<
  PortableStringEnumSchema,
  PortableStringEnumSchemaEncoded
> = Schema.TaggedStruct('StringEnum', {
  description: Schema.optionalKey(PortableDescription),
  values: PortableEnumValues,
})

type PortableLeafSchema =
  | PortableStringSchema
  | PortableNumberSchema
  | PortableIntegerSchema
  | PortableBooleanSchema
  | PortableStringEnumSchema

type PortableLeafSchemaEncoded =
  | PortableStringSchemaEncoded
  | PortableNumberSchemaEncoded
  | PortableIntegerSchemaEncoded
  | PortableBooleanSchemaEncoded
  | PortableStringEnumSchemaEncoded

const PortableLeafSchema: Schema.Codec<PortableLeafSchema, PortableLeafSchemaEncoded> =
  Schema.Union([
    PortableStringSchema,
    PortableNumberSchema,
    PortableIntegerSchema,
    PortableBooleanSchema,
    PortableStringEnumSchema,
  ])

const makePortableArraySchema = (
  items: Schema.Codec<PortableValueSchema, PortableValueSchemaEncoded>,
): Schema.Codec<PortableArraySchema, PortableArraySchemaEncoded> =>
  Schema.TaggedStruct('Array', {
    description: Schema.optionalKey(PortableDescription),
    items,
    minItems: PortableArrayBound,
    maxItems: PortableArrayBound,
  }).check(
    Schema.makeFilter((schema: PortableArraySchema) =>
      schema.minItems <= schema.maxItems ? true : 'Expected minItems <= maxItems',
    ),
  )

const makePortableObjectSchema = (
  value: Schema.Codec<PortableValueSchema, PortableValueSchemaEncoded>,
): Schema.Codec<PortableObjectSchema, PortableObjectSchemaEncoded> => {
  const property: Schema.Codec<PortableObjectProperty, PortableObjectPropertyEncoded> =
    Schema.Struct({
      name: PortablePropertyName,
      required: Schema.Boolean,
      schema: value,
    })

  const properties = Schema.Array(property).check(
    Schema.makeFilter((members: ReadonlyArray<PortableObjectProperty>) => {
      const names = members.map((member) => member.name)
      return new Set(names).size === names.length
        ? true
        : 'Expected unique portable object property names'
    }),
  )

  return Schema.TaggedStruct('Object', {
    description: Schema.optionalKey(PortableDescription),
    properties,
  })
}

const makePortableValueLayer = (
  child: Schema.Codec<PortableValueSchema, PortableValueSchemaEncoded>,
): Schema.Codec<PortableValueSchema, PortableValueSchemaEncoded> =>
  Schema.Union([
    PortableLeafSchema,
    makePortableArraySchema(child),
    makePortableObjectSchema(child),
  ])

// Build the decoder bottom-up. The finite shape rejects hostile deep values
// before any recursive walk can overflow the JavaScript call stack.
const PortableValueDepth2 = makePortableValueLayer(PortableLeafSchema)
const PortableValueDepth3 = makePortableValueLayer(PortableValueDepth2)
const PortableValueDepth4 = makePortableValueLayer(PortableValueDepth3)
const PortableValueDepth5 = makePortableValueLayer(PortableValueDepth4)

interface PortableSchemaMetrics {
  readonly depth: number
  readonly properties: number
}

const measurePortableSchema = (root: PortableValueSchema): PortableSchemaMetrics => {
  const pending: Array<{ readonly schema: PortableValueSchema; readonly depth: number }> = [
    { schema: root, depth: 1 },
  ]
  let depth = 0
  let properties = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    depth = Math.max(depth, current.depth)

    switch (current.schema._tag) {
      case 'Array':
        pending.push({ schema: current.schema.items, depth: current.depth + 1 })
        break
      case 'Object':
        properties += current.schema.properties.length
        for (const property of current.schema.properties) {
          pending.push({ schema: property.schema, depth: current.depth + 1 })
        }
        break
    }
  }

  return { depth, properties }
}

/**
 * The only schema shape accepted at the provider boundary. Object properties
 * are closed: adapters must compile them with `additionalProperties: false`.
 */
const portableSchemaWithinLimits = Schema.makeFilter((schema: PortableValueSchema) => {
  const metrics = measurePortableSchema(schema)
  if (metrics.depth > MAX_PORTABLE_SCHEMA_DEPTH) {
    return `Expected portable schema depth <= ${MAX_PORTABLE_SCHEMA_DEPTH}`
  }
  return metrics.properties <= MAX_PORTABLE_SCHEMA_PROPERTIES
    ? true
    : `Expected portable schema properties <= ${MAX_PORTABLE_SCHEMA_PROPERTIES}`
})

export const PortableToolInputSchema = makePortableObjectSchema(PortableValueDepth4).check(
  portableSchemaWithinLimits,
)

export interface PortableToolInputSchema extends Schema.Schema.Type<
  typeof PortableToolInputSchema
> {}

/** FeedbackTool output may be any JSON value described by the portable subset. */
export const PortableToolOutputSchema = PortableValueDepth5.check(portableSchemaWithinLimits)

export type PortableToolOutputSchema = typeof PortableToolOutputSchema.Type

const JsonArray = Schema.Array(Schema.Json)
const JsonObject = Schema.Record(Schema.String, Schema.Json)
const isJsonArray = Schema.is(JsonArray)
const isJsonObject = Schema.is(JsonObject)

const withinBounds = (value: number, minimum?: number, maximum?: number): boolean =>
  (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum)

const validatePortableObject = (schema: PortableObjectSchema, value: Schema.Json): boolean => {
  if (!isJsonObject(value)) return false

  const propertyNames = schema.properties.map((property) => property.name)
  if (Object.keys(value).some((name) => !propertyNames.includes(name))) return false

  return schema.properties.every((property) => {
    if (!Object.hasOwn(value, property.name)) return !property.required
    const propertyValue = value[property.name]
    return propertyValue !== undefined && validatePortableValue(property.schema, propertyValue)
  })
}

/** Validates an already-decoded JSON value against the portable schema AST. */
export const validatePortableValue = (schema: PortableValueSchema, value: Schema.Json): boolean => {
  switch (schema._tag) {
    case 'String':
      return typeof value === 'string'
    case 'StringEnum':
      return typeof value === 'string' && schema.values.includes(value)
    case 'Boolean':
      return typeof value === 'boolean'
    case 'Number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        withinBounds(value, schema.minimum, schema.maximum)
      )
    case 'Integer':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        withinBounds(value, schema.minimum, schema.maximum)
      )
    case 'Array':
      return (
        isJsonArray(value) &&
        value.length >= schema.minItems &&
        value.length <= schema.maxItems &&
        value.every((item) => validatePortableValue(schema.items, item))
      )
    case 'Object':
      return validatePortableObject(schema, value)
  }
}

/** Validates the closed JSON object supplied for a FeedbackTool or ActionTool call. */
export const validatePortableToolInput = (
  schema: PortableToolInputSchema,
  input: Readonly<Record<string, Schema.Json>>,
): boolean => validatePortableObject(schema, input)
