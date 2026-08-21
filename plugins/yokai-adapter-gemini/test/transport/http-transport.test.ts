import { ApiError } from '@google/genai'
import { HTTP } from '@cordisjs/plugin-http'
import { expect, it } from '@effect/vitest'
import { Context as CordisContext } from 'cordis'
import { Cause, Effect, Exit, Fiber, Layer, Queue, Schema } from 'effect'
import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http'

import { GeminiClientFactory } from '../../src/client/client-factory'
import { GeminiConfiguration } from '../../src/config/configuration'
import { GeminiConnection } from '../../src/connection/connection'
import { GeminiRuntime } from '../../src/runtime/layer'
import { GeminiHttpTransport } from '../../src/transport/http-transport'

const API_KEY = 'gemini-http-transport-api-key-canary'

interface ListeningServer {
  readonly baseUrl: string
  readonly server: Server
}

interface ObservedRequest {
  readonly headers: IncomingHttpHeaders
  readonly method: string | undefined
  readonly url: string | undefined
}

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

const makeEndpoint = Schema.decodeUnknownEffect(GeminiConfiguration.Endpoint)

const makeClientLayer = (http: HTTP) =>
  GeminiClientFactory.layer.pipe(Layer.provide(GeminiHttpTransport.layer(http)))

it.effect('routes SDK requests through ctx.http without replacing global fetch', () => {
  const observed: Array<ObservedRequest> = []
  const hookUrls: Array<string> = []
  const listener: RequestListener = (request, response) => {
    observed.push({
      headers: request.headers,
      method: request.method,
      url: request.url,
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        models: [
          {
            displayName: 'Gemini transport test',
            name: 'models/gemini-transport-test',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    )
  }

  return Effect.acquireUseRelease(
    startServer(listener),
    ({ baseUrl }) => {
      const ctx = new CordisContext()
      const http = new HTTP(ctx)
      const interceptedHttp = http.extend({ headers: { 'x-intercept-header': 'intercepted' } })
      const originalGlobalFetch = globalThis.fetch
      ctx.on('http/config', (config) => {
        const configuredHeaders = config.headers === undefined ? {} : config.headers
        Object.assign(config, {
          headers: {
            ...configuredHeaders,
            'x-context-header': 'context-one',
            'x-goog-api-key': 'must-be-overridden-by-sdk',
          },
        })
      })
      ctx.on('http/fetch-init', (url, init) => {
        hookUrls.push(url.toString())
        const headers = new Headers(init.headers)
        headers.set('x-fetch-hook', 'observed')
        Object.assign(init, { headers })
      })

      return Effect.gen(function* () {
        const endpoint = yield* makeEndpoint({ apiKey: API_KEY, baseUrl })
        const factory = yield* GeminiClientFactory.Service
        const client = yield* factory.create(endpoint)
        const pager = yield* Effect.tryPromise((signal) =>
          client.listModels({ config: {} }, signal),
        )

        expect(pager.page).toHaveLength(1)
        const model = pager.page[0]
        if (model === undefined) return yield* Effect.die('Expected one decoded SDK model')
        expect(model.name).toBe('models/gemini-transport-test')
        expect(model.displayName).toBe('Gemini transport test')
        expect(model.supportedActions).toEqual(['generateContent'])
        expect(globalThis.fetch).toBe(originalGlobalFetch)
        expect(hookUrls).toHaveLength(1)
        expect(observed).toHaveLength(1)
        const request = observed[0]
        if (request === undefined) return yield* Effect.die('Expected one observed request')
        expect(request.method).toBe('GET')
        expect(request.url).toContain('/v1beta/models')
        expect(request.url).not.toContain('alt=sse')
        expect(request.headers['x-context-header']).toBe('context-one')
        expect(request.headers['x-intercept-header']).toBe('intercepted')
        expect(request.headers['x-fetch-hook']).toBe('observed')
        expect(request.headers['x-goog-api-key']).toBe(API_KEY)
        expect(request.headers['x-server-timeout']).toBeUndefined()
      }).pipe(
        Effect.provide(makeClientLayer(interceptedHttp)),
        Effect.scoped,
        Effect.ensuring(stopContext(ctx)),
      )
    },
    ({ server }) => closeServer(server),
  )
})

it.effect('preserves non-2xx responses for SDK ApiError decoding without SDK retries', () => {
  let requests = 0
  const listener: RequestListener = (_request, response) => {
    requests += 1
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        error: {
          code: 429,
          message: 'rate limited',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    )
  }

  return Effect.acquireUseRelease(
    startServer(listener),
    ({ baseUrl }) => {
      const ctx = new CordisContext()
      const http = new HTTP(ctx)
      return Effect.gen(function* () {
        const endpoint = yield* makeEndpoint({ apiKey: API_KEY, baseUrl })
        const factory = yield* GeminiClientFactory.Service
        const client = yield* factory.create(endpoint)
        const error = yield* Effect.tryPromise({
          try: (signal) => client.listModels({ config: {} }, signal),
          catch: (cause) =>
            cause instanceof ApiError
              ? cause
              : new ApiError({ message: 'Unexpected SDK failure', status: 0 }),
        }).pipe(Effect.flip)

        expect(error).toBeInstanceOf(ApiError)
        expect(error.status).toBe(429)
        expect(requests).toBe(1)
      }).pipe(
        Effect.provide(makeClientLayer(http)),
        Effect.scoped,
        Effect.ensuring(stopContext(ctx)),
      )
    },
    ({ server }) => closeServer(server),
  )
})

it.effect('forwards unary RequestInit fields and preserves response metadata', () => {
  const fetchInits: Array<{
    readonly body: BodyInit | null | undefined
    readonly header: string | null
    readonly keepalive: boolean | undefined
    readonly method: string | undefined
    readonly redirect: RequestRedirect | undefined
  }> = []
  const listener: RequestListener = (_request, response) => {
    Object.assign(response, {
      statusCode: 201,
      statusMessage: 'Created by transport test',
    })
    response.setHeader('x-response-header', 'preserved')
    response.end('complete unary response')
  }

  return Effect.acquireUseRelease(
    startServer(listener),
    ({ baseUrl }) => {
      const ctx = new CordisContext()
      const http = new HTTP(ctx)
      ctx.on('http/fetch-init', (_url, init) => {
        fetchInits.push({
          body: init.body,
          header: new Headers(init.headers).get('x-request-header'),
          keepalive: init.keepalive,
          method: init.method,
          redirect: init.redirect,
        })
      })

      return Effect.gen(function* () {
        const transport = yield* GeminiHttpTransport.Service
        const response = yield* Effect.tryPromise((signal) =>
          transport.fetch(new URL('request-init', baseUrl), {
            body: '{"request":"body"}',
            headers: new Headers({ 'x-request-header': 'forwarded' }),
            keepalive: true,
            method: 'POST',
            redirect: 'manual',
            signal,
          }),
        )

        expect(fetchInits).toEqual([
          {
            body: '{"request":"body"}',
            header: 'forwarded',
            keepalive: true,
            method: 'POST',
            redirect: 'manual',
          },
        ])
        expect(response.status).toBe(201)
        expect(response.statusText).toBe('Created by transport test')
        expect(response.headers.get('x-response-header')).toBe('preserved')
        expect(yield* Effect.promise(() => response.text())).toBe('complete unary response')
      }).pipe(Effect.provide(GeminiHttpTransport.layer(http)), Effect.ensuring(stopContext(ctx)))
    },
    ({ server }) => closeServer(server),
  )
})

it.live('keeps ctx.http timeout active while buffering the complete unary body', () => {
  const listener: RequestListener = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"models":[')
  }

  return Effect.acquireUseRelease(
    startServer(listener),
    ({ baseUrl }) => {
      const ctx = new CordisContext()
      const http = new HTTP(ctx, { timeout: 25 })
      return Effect.gen(function* () {
        const transport = yield* GeminiHttpTransport.Service
        const error = yield* Effect.tryPromise({
          try: (signal) => transport.fetch(new URL('v1beta/models', baseUrl), { signal }),
          catch: (cause) =>
            cause instanceof GeminiHttpTransport.TimeoutError
              ? cause
              : new GeminiHttpTransport.TransportError('Unexpected transport failure'),
        }).pipe(Effect.flip)

        expect(error).toBeInstanceOf(GeminiHttpTransport.TimeoutError)
      }).pipe(Effect.provide(GeminiHttpTransport.layer(http)), Effect.ensuring(stopContext(ctx)))
    },
    ({ server }) => closeServer(server),
  )
})

it.effect('keeps two Koishi contexts transport-isolated', () => {
  const contextHeaders: Array<string | ReadonlyArray<string> | undefined> = []
  const listener: RequestListener = (request, response) => {
    contextHeaders.push(request.headers['x-context-id'])
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ models: [] }))
  }

  return Effect.acquireUseRelease(
    startServer(listener),
    ({ baseUrl }) => {
      const firstContext = new CordisContext()
      const secondContext = new CordisContext()
      const firstHttp = new HTTP(firstContext, { headers: { 'x-context-id': 'first' } })
      const secondHttp = new HTTP(secondContext, { headers: { 'x-context-id': 'second' } })

      const listModels = (http: HTTP, apiKey: string) =>
        Effect.gen(function* () {
          const endpoint = yield* makeEndpoint({ apiKey, baseUrl })
          const factory = yield* GeminiClientFactory.Service
          const client = yield* factory.create(endpoint)
          yield* Effect.tryPromise((signal) => client.listModels({ config: {} }, signal))
        }).pipe(Effect.provide(makeClientLayer(http)), Effect.scoped)

      return Effect.gen(function* () {
        yield* listModels(firstHttp, 'first-api-key')
        yield* listModels(secondHttp, 'second-api-key')
        expect(contextHeaders).toEqual(['first', 'second'])
      }).pipe(
        Effect.ensuring(stopContext(firstContext)),
        Effect.ensuring(stopContext(secondContext)),
      )
    },
    ({ server }) => closeServer(server),
  )
})

it.live('aborts buffered bodies on adapter close without disposing shared ctx.http', () =>
  Effect.gen(function* () {
    const bodyStarted = yield* Queue.unbounded<void>()
    const bodyClosed = yield* Queue.unbounded<void>()
    const listener: RequestListener = (request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('ok')
        return
      }
      response.on('close', () => Queue.offerUnsafe(bodyClosed, undefined))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"models":[')
      Queue.offerUnsafe(bodyStarted, undefined)
    }

    yield* Effect.acquireUseRelease(
      startServer(listener),
      ({ baseUrl }) => {
        const ctx = new CordisContext()
        const http = new HTTP(ctx)
        const config = {
          endpoints: [{ apiKey: API_KEY, baseUrl }],
          requestTimeoutMs: 60_000,
          discoveryRetry: {
            maxAttempts: 3,
            initialDelayMs: 1_000,
            maxDelayMs: 10_000,
            backoffMultiplier: 2,
          },
        }

        return Effect.gen(function* () {
          const connection = yield* GeminiConnection.Service
          const listingFiber = yield* Effect.forkChild(connection.listModels())
          yield* Queue.take(bodyStarted)

          expect(yield* connection.close()).toBe(true)
          const exit = yield* Fiber.await(listingFiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          yield* Queue.take(bodyClosed)

          const health = yield* Effect.tryPromise(() =>
            http(new URL('health', baseUrl), { responseType: 'text' }),
          )
          expect(health.data).toBe('ok')
        }).pipe(
          Effect.provide(GeminiRuntime.makeLayer(config, http)),
          Effect.ensuring(stopContext(ctx)),
        )
      },
      ({ server }) => closeServer(server),
    )
  }),
)
