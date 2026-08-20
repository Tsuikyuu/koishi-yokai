import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import {
  MAX_PORTABLE_ARRAY_ITEMS,
  MAX_PORTABLE_ENUM_VALUE_LENGTH,
  PortableToolInputSchema,
} from '../../src/llm-adapter/portable-schema.js'

it.effect('round-trips the closed portable FeedbackTool schema subset', () =>
  Effect.gen(function* () {
    const encoded = {
      _tag: 'Object',
      description: 'Search input',
      properties: [
        {
          name: 'query',
          required: true,
          schema: { _tag: 'String', description: 'Search query' },
        },
        {
          name: 'sources',
          required: false,
          schema: {
            _tag: 'Array',
            minItems: 0,
            maxItems: 3,
            items: {
              _tag: 'StringEnum',
              values: ['web', 'archive'],
            },
          },
        },
        {
          name: 'limit',
          required: false,
          schema: { _tag: 'Integer', minimum: 1, maximum: 100 },
        },
        {
          name: 'depth_boundary',
          required: false,
          schema: {
            _tag: 'Object',
            properties: [
              {
                name: 'items',
                required: true,
                schema: {
                  _tag: 'Array',
                  minItems: 0,
                  maxItems: 1,
                  items: {
                    _tag: 'Object',
                    properties: [
                      {
                        name: 'value',
                        required: true,
                        schema: { _tag: 'Integer' },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    }

    const schema = yield* Schema.decodeUnknownEffect(PortableToolInputSchema)(encoded)
    expect(yield* Schema.encodeEffect(PortableToolInputSchema)(schema)).toEqual(encoded)
  }),
)

it.effect('rejects non-portable, duplicate, unbounded, and over-deep shapes', () =>
  Effect.gen(function* () {
    const duplicateProperties = {
      _tag: 'Object',
      properties: [
        { name: 'query', required: true, schema: { _tag: 'String' } },
        { name: 'query', required: false, schema: { _tag: 'Boolean' } },
      ],
    }
    const invalidArray = {
      _tag: 'Object',
      properties: [
        {
          name: 'items',
          required: true,
          schema: {
            _tag: 'Array',
            minItems: 2,
            maxItems: 1,
            items: { _tag: 'Number' },
          },
        },
      ],
    }
    const oversizedArray = {
      _tag: 'Object',
      properties: [
        {
          name: 'items',
          required: true,
          schema: {
            _tag: 'Array',
            minItems: 0,
            maxItems: MAX_PORTABLE_ARRAY_ITEMS + 1,
            items: { _tag: 'Number' },
          },
        },
      ],
    }
    const unboundedArray = {
      _tag: 'Object',
      properties: [
        {
          name: 'items',
          required: true,
          schema: {
            _tag: 'Array',
            minItems: 0,
            items: { _tag: 'Number' },
          },
        },
      ],
    }
    const duplicateEnum = {
      _tag: 'Object',
      properties: [
        {
          name: 'mode',
          required: true,
          schema: { _tag: 'StringEnum', values: ['same', 'same'] },
        },
      ],
    }
    const oversizedEnumValue = {
      _tag: 'Object',
      properties: [
        {
          name: 'mode',
          required: true,
          schema: { _tag: 'StringEnum', values: ['x'.repeat(MAX_PORTABLE_ENUM_VALUE_LENGTH + 1)] },
        },
      ],
    }
    const invalidNumericBounds = {
      _tag: 'Object',
      properties: [
        {
          name: 'score',
          required: true,
          schema: { _tag: 'Number', minimum: 2, maximum: 1 },
        },
      ],
    }
    const invalidIntegerBound = {
      _tag: 'Object',
      properties: [
        {
          name: 'limit',
          required: true,
          schema: { _tag: 'Integer', minimum: 0.5, maximum: 10 },
        },
      ],
    }
    const tooManyProperties = {
      _tag: 'Object',
      properties: Array.from({ length: 101 }, (_, index) => ({
        name: `field_${index}`,
        required: false,
        schema: { _tag: 'Boolean' },
      })),
    }
    const overDeep = {
      _tag: 'Object',
      properties: [
        {
          name: 'one',
          required: true,
          schema: {
            _tag: 'Object',
            properties: [
              {
                name: 'two',
                required: true,
                schema: {
                  _tag: 'Object',
                  properties: [
                    {
                      name: 'three',
                      required: true,
                      schema: {
                        _tag: 'Object',
                        properties: [
                          {
                            name: 'four',
                            required: true,
                            schema: {
                              _tag: 'Object',
                              properties: [
                                {
                                  name: 'leaf',
                                  required: true,
                                  schema: { _tag: 'String' },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    }
    const errors = yield* Effect.all(
      [
        { _tag: 'String' },
        duplicateProperties,
        invalidArray,
        oversizedArray,
        unboundedArray,
        duplicateEnum,
        oversizedEnumValue,
        invalidNumericBounds,
        invalidIntegerBound,
        tooManyProperties,
        overDeep,
      ].map((input) =>
        Schema.decodeUnknownEffect(PortableToolInputSchema)(input).pipe(Effect.flip),
      ),
    )

    expect(errors.every(Schema.isSchemaError)).toBe(true)
  }),
)

it.effect('rejects hostile depth as a typed SchemaError without overflowing the stack', () =>
  Effect.gen(function* () {
    let encoded: Schema.Json = { _tag: 'String' }
    for (let index = 0; index < 500; index += 1) {
      encoded = {
        _tag: 'Object',
        properties: [
          {
            name: `level_${index}`,
            required: true,
            schema: encoded,
          },
        ],
      }
    }

    interface CyclicPortableObject {
      readonly _tag: 'Object'
      readonly properties: Array<{
        readonly name: string
        readonly required: boolean
        readonly schema: CyclicPortableObject
      }>
    }
    const cyclicProperties: CyclicPortableObject['properties'] = []
    const cyclic: CyclicPortableObject = { _tag: 'Object', properties: cyclicProperties }
    cyclicProperties.push({ name: 'cycle', required: true, schema: cyclic })

    const errors = yield* Effect.all([
      Schema.decodeUnknownEffect(PortableToolInputSchema)(encoded).pipe(Effect.flip),
      Schema.decodeUnknownEffect(PortableToolInputSchema)(cyclic).pipe(Effect.flip),
    ])
    expect(errors.every(Schema.isSchemaError)).toBe(true)
  }),
)
