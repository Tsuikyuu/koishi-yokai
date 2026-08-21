import { Context, Layer } from 'effect'
import type { HTTP } from 'koishi'

export type FetchImplementation = (url: URL, init: RequestInit) => Promise<Response>

export interface Interface {
  readonly fetch: FetchImplementation
}

export class Service extends Context.Service<Service, Interface>()(
  '@yokai/koishi-plugin-yokai-adapter-gemini/HttpTransport',
) {}

export class TimeoutError extends Error {
  readonly name = 'GeminiHttpTimeoutError'
}

export class TransportError extends Error {
  readonly name = 'GeminiHttpTransportError'
}

const isHttpMethod = (method: string): method is HTTP.Method => {
  switch (method) {
    case 'get':
    case 'GET':
    case 'delete':
    case 'DELETE':
    case 'head':
    case 'HEAD':
    case 'options':
    case 'OPTIONS':
    case 'post':
    case 'POST':
    case 'put':
    case 'PUT':
    case 'patch':
    case 'PATCH':
    case 'purge':
    case 'PURGE':
    case 'link':
    case 'LINK':
    case 'unlink':
    case 'UNLINK':
      return true
    default:
      return false
  }
}

const normalizeHeaders = (headers: HeadersInit | undefined): Record<string, string> => {
  const normalized: Record<string, string> = {}
  if (headers === undefined) return normalized
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value
  })
  return normalized
}

const bufferResponse = (raw: Response): Promise<Response> => {
  const hasBody = raw.body !== null
  return raw.arrayBuffer().then(
    (body) =>
      new Response(hasBody ? body : null, {
        headers: raw.headers,
        status: raw.status,
        statusText: raw.statusText,
      }),
  )
}

const makeFetch =
  (http: HTTP): FetchImplementation =>
  (url, init) => {
    const method = init.method === undefined ? 'GET' : init.method
    if (!isHttpMethod(method)) {
      return Promise.reject(new TransportError(`Unsupported HTTP method: ${method}`))
    }

    const keepAlive = init.keepalive === undefined ? {} : { keepAlive: init.keepalive }
    const redirect = init.redirect === undefined ? {} : { redirect: init.redirect }
    const signal = init.signal === null || init.signal === undefined ? {} : { signal: init.signal }

    return http(url.toString(), {
      data: init.body,
      headers: normalizeHeaders(init.headers),
      method,
      responseType: bufferResponse,
      validateStatus: () => true,
      ...keepAlive,
      ...redirect,
      ...signal,
    })
      .then((response) => response.data)
      .catch((error) => {
        if (init.signal !== null && init.signal !== undefined && init.signal.aborted) {
          return Promise.reject(init.signal.reason)
        }
        if (http.isError(error) && error.code === 'ETIMEDOUT') {
          return Promise.reject(new TimeoutError('Gemini HTTP request timed out'))
        }
        return Promise.reject(new TransportError('Gemini HTTP request failed'))
      })
  }

export const layer = (http: HTTP) =>
  Layer.succeed(
    Service,
    Service.of({
      fetch: makeFetch(http),
    }),
  )

/** Internal injection seam for deterministic adapter tests. */
export const layerWithFetch = (fetch: FetchImplementation) =>
  Layer.succeed(Service, Service.of({ fetch }))

export * as GeminiHttpTransport from './http-transport'
