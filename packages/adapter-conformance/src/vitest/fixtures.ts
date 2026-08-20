import { Schema } from 'effect'

import { ContinueRequest, GenerateRequest, type AdapterContinuation } from '@yokai/protocol'

import { AdapterConformanceSetup } from '../conformance/index.js'

export const decodeConformanceSetup = (input: typeof AdapterConformanceSetup.Encoded) =>
  Schema.decodeUnknownEffect(AdapterConformanceSetup)(input)

export const makeTextRequest = () =>
  Schema.decodeUnknownEffect(GenerateRequest)({
    modelId: 'models/text',
    messages: [{ role: 'user', content: 'Hello from the conformance suite' }],
    limits: { maxOutputTokens: 256 },
    feedbackTools: [],
  })

export const makeFeedbackRequest = () =>
  Schema.decodeUnknownEffect(GenerateRequest)({
    modelId: 'models/text',
    messages: [{ role: 'user', content: 'Use the visible tools if needed' }],
    limits: { maxOutputTokens: 256 },
    feedbackTools: [
      {
        id: 'history.search',
        description: 'Search a bounded history snapshot',
        inputSchema: {
          _tag: 'Object',
          properties: [
            {
              name: 'query',
              required: true,
              schema: { _tag: 'String' },
            },
          ],
        },
      },
      {
        id: 'web.search',
        description: 'Search a bounded public index',
        inputSchema: {
          _tag: 'Object',
          properties: [
            {
              name: 'query',
              required: true,
              schema: { _tag: 'String' },
            },
          ],
        },
      },
    ],
  })

export const makeSingleResultContinueRequest = (continuation: AdapterContinuation) =>
  Schema.decodeUnknownEffect(ContinueRequest)({
    continuation,
    results: [
      {
        _tag: 'Success',
        callId: 'call-a',
        output: { matches: ['one', 'two'] },
      },
    ],
  })

export const makeReversedResultContinueRequest = (continuation: AdapterContinuation) =>
  Schema.decodeUnknownEffect(ContinueRequest)({
    continuation,
    results: [
      {
        _tag: 'Failure',
        callId: 'call-b',
        reason: 'timeout',
        message: 'The bounded search timed out',
      },
      {
        _tag: 'Success',
        callId: 'call-a',
        output: ['one', 2, false],
      },
    ],
  })

export const makeMismatchedResultContinueRequest = (continuation: AdapterContinuation) =>
  Schema.decodeUnknownEffect(ContinueRequest)({
    continuation,
    results: [
      {
        _tag: 'Success',
        callId: 'call-a',
        output: { incomplete: true },
      },
    ],
  })

export const makeForeignContinueRequest = (continuation: AdapterContinuation) =>
  Schema.decodeUnknownEffect(ContinueRequest)({
    continuation,
    results: [
      {
        _tag: 'Success',
        callId: 'call-a',
        output: true,
      },
    ],
  })
