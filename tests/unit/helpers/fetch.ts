/** Unit-only transport: an unmatched request throws; real network is never used. */

export type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  /** Request body as text, when there was one. */
  body: string | null
  /** 1-based index over ALL stubbed calls, in order. */
  n: number
}

/** What a route answers with: a Response, or the shorthand for building one. */
export type StubReply =
  | Response
  | { status?: number; body?: unknown; headers?: Record<string, string> }

export type RouteHandler = (call: FetchCall) => StubReply | Promise<StubReply>

/** Route key → reply. A key matches when the request URL CONTAINS it. */
export type Routes = Record<string, StubReply | RouteHandler>

export type FetchStub = {
  /** Every stubbed call, in order (requests that fell through are not logged). */
  calls: FetchCall[]
  restore: () => void
}

function toResponse(reply: StubReply): Response {
  if (reply instanceof Response) return reply
  const { status = 200, body, headers } = reply
  if (body === undefined) return new Response('', { status, headers })
  if (typeof body === 'string') return new Response(body, { status, headers })
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function stubFetch(routes: Routes): FetchStub {
  const real = globalThis.fetch
  const calls: FetchCall[] = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const key = Object.keys(routes).find((route) => url.includes(route))
    if (key === undefined) throw new Error('Unexpected unit-test network request')

    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (value, name) => {
        headers[name] = value
      },
    )
    const call: FetchCall = {
      url,
      method: String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      headers,
      body: init?.body === undefined || init.body === null ? null : String(init.body),
      n: calls.length + 1,
    }
    calls.push(call)

    const route = routes[key]
    return toResponse(typeof route === 'function' ? await route(call) : route)
  }) as typeof fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = real
    },
  }
}
