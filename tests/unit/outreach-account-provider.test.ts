import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyScopedInstantlyAccount as verify } from '../../src/lib/instantly.ts'

const WORKSPACE = '92b1c88c-a3fa-4ae3-b1ce-7d1e303c6f17'
const OTHER = '8b6bd2cb-9404-4e5d-b3e9-fbf7a8b1b8aa'
const EMAIL = 'pilot@example.test'
const KEY = 'dedicated-fixture-key'
function harness(replies: { body: unknown; status?: number }[]) {
  const calls: Request[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    calls.push(request)
    const reply = replies.shift()
    assert.ok(reply, 'Unexpected provider request')
    return Response.json(reply.body, { status: reply.status ?? 200 })
  }
  return { calls, options: { apiKey: KEY, expectedWorkspaceId: WORKSPACE, fetch: fetcher } }
}
const account = { email: EMAIL, organization: WORKSPACE, status: 1, setup_pending: false }

test('scoped account verification checks the workspace before the exact mailbox with one dedicated key', async () => {
  const { calls, options } = harness([{ body: { id: WORKSPACE } }, { body: account }])
  assert.deepEqual(await verify(EMAIL, options), { state: 'connected', error: null })
  assert.deepEqual(calls.map((r) => new URL(r.url).pathname), ['/api/v2/workspaces/current', `/api/v2/accounts/${encodeURIComponent(EMAIL)}`])
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://api.instantly.ai')
    assert.equal(call.method, 'GET')
    assert.equal(call.headers.get('authorization'), `Bearer ${KEY}`)
    assert.equal(call.headers.get('x-as-workspace'), null)
    assert.equal(call.cache, 'no-store')
    assert.equal(call.redirect, 'error')
  }
})

test('every documented state is mapped without exposing the provider response', async () => {
  for (const [status, state] of [[1, 'connected'], [2, 'paused'], [3, 'maintenance'], [-1, 'needs_attention'], [-2, 'needs_attention'], [-3, 'needs_attention']] as const) {
    const { options } = harness([{ body: { id: WORKSPACE } }, { body: { ...account, status, secret: 'private' } }])
    assert.deepEqual(await verify(EMAIL, options), { state, error: null })
  }
  const { options } = harness([{ body: { id: WORKSPACE } }, { body: { ...account, setup_pending: true } }])
  assert.deepEqual(await verify(EMAIL, options), { state: 'setting_up', error: null })
})

test('a workspace mismatch stops before requesting the mailbox', async () => {
  const { options, calls } = harness([{ body: { id: OTHER } }])
  assert.deepEqual(await verify(EMAIL, options), { state: null, error: 'scope_mismatch' })
  assert.equal(calls.length, 1)
})

test('account ownership and exact normalized email must match independently', async () => {
  for (const [body, error] of [[{ ...account, organization: OTHER }, 'scope_mismatch'], [{ ...account, email: 'other@example.test' }, 'identity_mismatch']] as const) {
    const { options } = harness([{ body: { id: WORKSPACE } }, { body }])
    assert.deepEqual(await verify(EMAIL, options), { state: null, error })
  }
  const { options } = harness([{ body: { id: WORKSPACE } }, { body: { ...account, email: ' PILOT@EXAMPLE.TEST ' } }])
  assert.deepEqual(await verify(' PILOT@EXAMPLE.TEST ', options), { state: 'connected', error: null })
})

test('only a mailbox 404 after verified workspace is a negative observation', async () => {
  const accountMissing = harness([{ body: { id: WORKSPACE } }, { body: { secret: 'private' }, status: 404 }])
  assert.deepEqual(await verify(EMAIL, accountMissing.options), { state: 'needs_attention', error: null })
  const workspaceMissing = harness([{ body: { secret: 'private' }, status: 404 }])
  assert.deepEqual(await verify(EMAIL, workspaceMissing.options), { state: null, error: 'check_unavailable' })
})

test('malformed and unknown provider states fail closed', async () => {
  for (const body of [null, [], {}, { ...account, organization: null }, { ...account, email: null }, { ...account, status: 0 }, { ...account, status: '1' }, { ...account, setup_pending: null }, { ...account, setup_pending: undefined }, { ...account, status: 9, setup_pending: true }]) {
    const { options } = harness([{ body: { id: WORKSPACE } }, { body }])
    assert.deepEqual(await verify(EMAIL, options), { state: null, error: 'check_unavailable' })
  }
})

test('credentials and input must be valid before any provider call', async () => {
  for (const [email, overrides] of [['bad', {}], [EMAIL, { apiKey: '' }], [EMAIL, { expectedWorkspaceId: 'bad' }]] as const) {
    const { options, calls } = harness([])
    assert.deepEqual(await verify(email, { ...options, ...overrides }), { state: null, error: 'check_unavailable' })
    assert.equal(calls.length, 0)
  }
})

test('provider errors, redirects and throttling are neutral and never retried', async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    for (const checkedWorkspace of [false, true]) {
      const replies = [
        ...(checkedWorkspace ? [{ body: { id: WORKSPACE } }] : []),
        { body: { private: KEY }, status },
      ]
      const { calls, options } = harness(replies)
      assert.deepEqual(await verify(EMAIL, options), { state: null, error: 'check_unavailable' })
      assert.equal(calls.length, checkedWorkspace ? 2 : 1)
    }
  }
  const { options } = harness([])
  options.fetch = async () => { throw new Error(KEY) }
  assert.deepEqual(await verify(EMAIL, options), { state: null, error: 'check_unavailable' })
})

test('a stalled account response shares the bounded deadline and propagates cancellation', async () => {
  let aborted = false
  let firstSignal: AbortSignal | undefined
  const fetcher: typeof fetch = async (input, init) => {
    const signal = init?.signal as AbortSignal
    if (new URL(String(input)).pathname.endsWith('/current')) { firstSignal = signal; return Response.json({ id: WORKSPACE }) }
    assert.equal(signal, firstSignal)
    return await new Promise<Response>((resolve, reject) => {
      const keepAlive = setTimeout(() => resolve(Response.json(account)), 100)
      signal.addEventListener('abort', () => { aborted = true; clearTimeout(keepAlive); reject(new Error(KEY)) }, { once: true })
    })
  }
  assert.deepEqual(await verify(EMAIL, { apiKey: KEY, expectedWorkspaceId: WORKSPACE, fetch: fetcher, timeoutMs: 10 }), { state: null, error: 'check_unavailable' })
  assert.equal(aborted, true)
  const { options, calls } = harness([])
  assert.deepEqual(await verify(EMAIL, { ...options, signal: AbortSignal.abort() }), { state: null, error: 'check_unavailable' })
  assert.equal(calls.length, 0)
})
