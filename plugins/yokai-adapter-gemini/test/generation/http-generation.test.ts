import { HTTP } from '@cordisjs/plugin-http'
import { expect, it } from '@effect/vitest'
import { GenerateRequest } from '@yokai/protocol'
import { Context as CordisContext } from 'cordis'
import { Cause, Effect, Exit, Fiber, Layer, Queue, Schema } from 'effect'
import { createServer, type RequestListener, type Server } from 'node:http'

import { GeminiClientFactory } from '../../src/client/client-factory'
import { GeminiConfiguration } from '../../src/config/configuration'
import { GeminiConnection } from '../../src/connection/connection'
import { GeminiTextGeneration } from '../../src/generation/generation'
import { GeminiHttpTransport } from '../../src/transport/http-transport'

const API_KEY = 'gemini-generation-http-key-canary'

interface ListeningServer {
  readonly baseUrl: string
  readonly server: Server
}

interface ObservedRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly body: string
}

const WirePart = Schema.Struct({ text: Schema.String })
const WireContent = Schema.Struct({
  role: Schema.String,
  parts: Schema.Array(WirePart),
})
const WireRequest = Schema.Struct({
  systemInstruction: WireContent,
  contents: Schema.Array(WireContent),
  generationConfig: Schema.Struct({
    candidateCount: Schema.Number,
    maxOutputTokens: Schema.Number,
  }),
})

const startServer = (listener: RequestListener) =>
  Effect.tryPromise(
    () =>
      new Promise<ListeningServer>((resolve, reject) => {
        const server = createServer(listener)
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError)
          const address = server.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('Expected an IPv4 test server address'))
            return
          }
          resolve({
            baseUrl: `http://127.0.0.1:${address.port}/`,
            server,
          })
        })
      }),
  )

const closeServer = (server: Server) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      }),
  )

const stopContext = (ctx: CordisContext) => Effect.promise(() => ctx.stop())

const makeConfig = (baseUrl: string) => ({
  adapterId: 'gemini-http-generation-test',
  endpoints: [{ apiKey: API_KEY, baseUrl }],
  requestTimeoutMs: 60_000,
  discoveryRetry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 10_000,
    backoffMultiplier: 2,
  },
})

const makeGenerationLayer = (baseUrl: string, http: HTTP) => {
  const connectionLayer = GeminiConnection.layer.pipe(
    Layer.provide(GeminiConfiguration.layer(makeConfig(baseUrl))),
    Layer.provide(GeminiClientFactory.layer.pipe(Layer.provide(GeminiHttpTransport.layer(http)))),
  )
  return GeminiTextGeneration.layer.pipe(Layer.provideMerge(connectionLayer))
}

const makeRequest = Schema.decodeUnknownEffect(GenerateRequest)({
  modelId: 'gemini-2.5-flash',
  systemInstruction: 'Stay inside the assigned character.',
  messages: [
    { role: 'user', content: 'First user turn' },
    { role: 'assistant', content: 'First model turn' },
    { role: 'user', content: 'Second user turn' },
  ],
  limits: { maxOutputTokens: 96 },
  feedbackTools: [],
})

it.effect('sends one unary SDK request with the expected Gemini wire mapping', () => {
  const observed: Array<ObservedRequest> = []
  const listener: RequestListener = (request, response) => {
    const chunks: Array<Buffer> = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      observed.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: '<yokai-response>hello</yokai-response>' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 14,
            candidatesTokenCount: 6,
            totalTokenCount: 20,
          },
        }),
      )
    })
  }

  return Effect.acquireUseRelease(
    startServer(listener),
    ({ baseUrl }) => {
      const ctx = new CordisContext()
      const http = new HTTP(ctx)
      return Effect.gen(function* () {
        const request = yield* makeRequest
        const generation = yield* GeminiTextGeneration.Service
        const result = yield* generation.generate(request)

        expect(result).toEqual({
          _tag: 'Text',
          text: '<yokai-response>hello</yokai-response>',
          finishReason: 'stop',
          usage: {
            _tag: 'Reported',
            inputTokens: 14,
            outputTokens: 6,
            totalTokens: 20,
          },
        })
        expect(observed).toHaveLength(1)
        const providerRequest = observed[0]
        if (providerRequest === undefined) {
          return yield* Effect.die('Expected one Gemini generation request')
        }
        expect(providerRequest.method).toBe('POST')
        expect(providerRequest.url).toContain('/v1beta/models/gemini-2.5-flash:generateContent')
        expect(providerRequest.url).not.toContain('alt=sse')
        expect(providerRequest.body).not.toContain('tools')
        const wire = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WireRequest))(
          providerRequest.body,
        )
        expect(wire).toEqual({
          systemInstruction: {
            role: 'user',
            parts: [{ text: 'Stay inside the assigned character.' }],
          },
          contents: [
            { role: 'user', parts: [{ text: 'First user turn' }] },
            { role: 'model', parts: [{ text: 'First model turn' }] },
            { role: 'user', parts: [{ text: 'Second user turn' }] },
          ],
          generationConfig: {
            candidateCount: 1,
            maxOutputTokens: 96,
          },
        })
      }).pipe(Effect.provide(makeGenerationLayer(baseUrl, http)), Effect.ensuring(stopContext(ctx)))
    },
    ({ server }) => closeServer(server),
  )
})

it.effect('classifies non-2xx and malformed JSON responses without SDK retries', () => {
  let requests = 0
  const listener: RequestListener = (request, response) => {
    requests += 1
    request.resume()
    if (requests === 1) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            code: 400,
            message: 'provider-private-error-canary',
            status: 'INVALID_ARGUMENT',
          },
        }),
      )
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"candidates":[')
  }

  return Effect.acquireUseRelease(
    startServer(listener),
    ({ baseUrl }) => {
      const ctx = new CordisContext()
      const http = new HTTP(ctx)
      return Effect.gen(function* () {
        const request = yield* makeRequest
        const generation = yield* GeminiTextGeneration.Service
        const providerFailure = yield* generation.generate(request).pipe(Effect.flip)
        const malformedFailure = yield* generation.generate(request).pipe(Effect.flip)

        expect(providerFailure._tag).toBe('AdapterProviderResponseError')
        if (providerFailure._tag === 'AdapterProviderResponseError') {
          expect(providerFailure.statusCode).toBe(400)
          expect(providerFailure.message).toBe('Gemini rejected the generation request')
        }
        expect(JSON.stringify(providerFailure)).not.toContain('provider-private-error-canary')
        expect(malformedFailure._tag).toBe('AdapterProtocolDecodeError')
        expect(requests).toBe(2)
      }).pipe(Effect.provide(makeGenerationLayer(baseUrl, http)), Effect.ensuring(stopContext(ctx)))
    },
    ({ server }) => closeServer(server),
  )
})

it.live('interrupts an in-flight unary generation body through ctx.http', () =>
  Effect.gen(function* () {
    const bodyStarted = yield* Queue.unbounded<void>()
    const bodyClosed = yield* Queue.unbounded<void>()
    const listener: RequestListener = (_request, response) => {
      response.on('close', () => Queue.offerUnsafe(bodyClosed, undefined))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"candidates":[')
      Queue.offerUnsafe(bodyStarted, undefined)
    }

    yield* Effect.acquireUseRelease(
      startServer(listener),
      ({ baseUrl }) => {
        const ctx = new CordisContext()
        const http = new HTTP(ctx)
        return Effect.gen(function* () {
          const request = yield* makeRequest
          const generation = yield* GeminiTextGeneration.Service
          const fiber = yield* Effect.forkChild(generation.generate(request))
          yield* Queue.take(bodyStarted)

          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          yield* Queue.take(bodyClosed)
        }).pipe(
          Effect.provide(makeGenerationLayer(baseUrl, http)),
          Effect.ensuring(stopContext(ctx)),
        )
      },
      ({ server }) => closeServer(server),
    )
  }),
)
