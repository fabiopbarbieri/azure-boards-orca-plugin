import { assert, test } from 'orca/testing'
import type { Connection } from './azure'
import { boardAnswer, type Call, FAKE_PAT, fakeFetch, html, json, netError, routedFetch, type Route } from './fake-fetch'
import { moveItem, parseMove } from './move'
import type { BoardRef } from './protocol'

const conn: Connection = {
  organization: 'contoso',
  pat: FAKE_PAT,
  hiddenStates: [],
  allProjects: true,
  projects: [],
  stripAreaPrefix: true
}
const ref: BoardRef = {
  projectId: 'p-1',
  projectName: 'Web',
  teamId: 't-1',
  teamName: 'Team A',
  boardId: 'b1',
  boardName: 'Stories'
}
const PATCH_URL = 'https://dev.azure.com/contoso/_apis/wit/workitems/42?api-version=7.1'

// c0 New (Story: New), c1 Doing split (Story: Active, Bug: Active), c2 Review (Story only)
const board = () =>
  boardAnswer([
    ['New', 'incoming', 0, false, { Story: 'New', Bug: 'New' }],
    ['Doing', 'inProgress', 3, true, { Story: 'Active', Bug: 'Active' }],
    ['Review', 'inProgress', 0, false, { Story: 'Resolved' }]
  ])
const typeAnswer = (type: string) => json({ id: 42, fields: { 'System.WorkItemType': type } })
const routes = (type: string, patch: Route[1] = json({ id: 42 })): Route[] => [
  ['/work/boards/b1', board()],
  ['/_apis/wit/workitems/42?fields=', typeAnswer(type)],
  [(c) => c.method === 'PATCH', patch]
]
const patchCall = (f: { calls: Call[] }) => f.calls.filter((c) => c.method === 'PATCH')

test('parseMove validates the input', () => {
  assert.deepEqual(parseMove({ id: 1, target: { kind: 'state', state: 'Active' } }), { id: 1, target: { kind: 'state', state: 'Active' } })
  assert.deepEqual(parseMove({ id: 1, target: { kind: 'column', columnId: 'c', done: false } }), {
    id: 1,
    target: { kind: 'column', columnId: 'c', done: false }
  })
  for (const bad of [
    null,
    {},
    { id: 0, target: { kind: 'state', state: 'A' } },
    { id: 1.5, target: { kind: 'state', state: 'A' } },
    { id: '1', target: { kind: 'state', state: 'A' } },
    { id: 1 },
    { id: 1, target: { kind: 'state', state: '' } },
    { id: 1, target: { kind: 'state', state: 3 } },
    { id: 1, target: { kind: 'column', columnId: '', done: true } },
    { id: 1, target: { kind: 'column', columnId: 'c' } },
    { id: 1, target: { kind: 'column', columnId: 'c', done: 'yes' } },
    { id: 1, target: { kind: 'other' } }
  ]) {
    assert.equal(parseMove(bad), null, JSON.stringify(bad))
  }
})

test('moves to a state with one PATCH', async () => {
  const fetch = routedFetch([(c) => c.method === 'PATCH', json({ id: 42 })])
  const result = await moveItem(conn, null, 42, { kind: 'state', state: 'Active' }, fetch)
  assert.deepEqual(result, { ok: true })
  assert.equal(fetch.calls.length, 1)
  const call = fetch.calls[0]!
  assert.equal(call.url, PATCH_URL)
  assert.equal(call.headers['Content-Type'], 'application/json-patch+json')
  assert.deepEqual(call.body, [{ op: 'add', path: '/fields/System.State', value: 'Active' }])
})

test('moves to the Doing half of a split column', async () => {
  const fetch = routedFetch(...routes('Story'))
  const result = await moveItem(conn, ref, 42, { kind: 'column', columnId: 'c1', done: false }, fetch)
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(patchCall(fetch)[0]!.body, [
    { op: 'add', path: '/fields/WEF_1_Kanban.Column', value: 'Doing' },
    { op: 'add', path: '/fields/WEF_1_Kanban.Column.Done', value: false },
    { op: 'add', path: '/fields/System.State', value: 'Active' }
  ])
  const urls = fetch.calls.map((c) => c.url)
  assert.ok(urls.includes('https://dev.azure.com/contoso/p-1/t-1/_apis/work/boards/b1?api-version=7.1'))
  assert.ok(urls.includes('https://dev.azure.com/contoso/_apis/wit/workitems/42?fields=System.WorkItemType&api-version=7.1'))
})

test('moves to the Done half of a split column', async () => {
  const fetch = routedFetch(...routes('Bug'))
  await moveItem(conn, ref, 42, { kind: 'column', columnId: 'c1', done: true }, fetch)
  assert.deepEqual(patchCall(fetch)[0]!.body, [
    { op: 'add', path: '/fields/WEF_1_Kanban.Column', value: 'Doing' },
    { op: 'add', path: '/fields/WEF_1_Kanban.Column.Done', value: true },
    { op: 'add', path: '/fields/System.State', value: 'Active' }
  ])
})

test('a non-split column clears the done field, whatever `done` says', async () => {
  const fetch = routedFetch(...routes('Story'))
  await moveItem(conn, ref, 42, { kind: 'column', columnId: 'c2', done: true }, fetch)
  assert.deepEqual(patchCall(fetch)[0]!.body, [
    { op: 'add', path: '/fields/WEF_1_Kanban.Column', value: 'Review' },
    { op: 'add', path: '/fields/WEF_1_Kanban.Column.Done', value: false },
    { op: 'add', path: '/fields/System.State', value: 'Resolved' }
  ])
})

test('a column that does not map the item type is a rule error and patches nothing', async () => {
  const fetch = routedFetch(...routes('Bug'))
  const result = await moveItem(conn, ref, 42, { kind: 'column', columnId: 'c2', done: false }, fetch)
  assert.deepEqual(result, { ok: false, error: { kind: 'rule', detail: 'the column does not accept this work item type' } })
  assert.equal(patchCall(fetch).length, 0)
})

test('an unknown column is a server error and patches nothing', async () => {
  const fetch = routedFetch(...routes('Story'))
  const result = await moveItem(conn, ref, 42, { kind: 'column', columnId: 'zzz', done: false }, fetch)
  assert.deepEqual(result, { ok: false, error: { kind: 'server', detail: 'unknown column' } })
  assert.equal(patchCall(fetch).length, 0)
})

test('a column target without a stored board asks nothing', async () => {
  const fetch = routedFetch()
  const result = await moveItem(conn, null, 42, { kind: 'column', columnId: 'c1', done: false }, fetch)
  assert.deepEqual(result, { ok: false, error: { kind: 'boardNotConfigured' } })
  assert.equal(fetch.calls.length, 0)
})

test('the GETs keep their usual error mapping', async () => {
  const fetch = routedFetch(
    ['/work/boards/b1', json({ message: 'gone' }, 404)],
    ['/_apis/wit/workitems/42?fields=', typeAnswer('Story')]
  )
  const result = await moveItem(conn, ref, 42, { kind: 'column', columnId: 'c1', done: false }, fetch)
  assert.deepEqual(result, { ok: false, error: { kind: 'notFound', detail: 'gone' } })
  const f2 = routedFetch(['/work/boards/b1', board()], ['/_apis/wit/workitems/42?fields=', json({ message: 'no' }, 403)])
  const r2 = await moveItem(conn, ref, 42, { kind: 'column', columnId: 'c1', done: false }, f2)
  assert.deepEqual(r2, { ok: false, error: { kind: 'scope', detail: 'no' } })
})

test('401, a redirect, 203 and 403 on the PATCH read as writeScope', async () => {
  for (const answer of [json({}, 401), html(302, 'https://login'), html(203), json({ message: 'TF401027: needs write' }, 403)]) {
    const fetch = routedFetch([(c) => c.method === 'PATCH', answer])
    const result = await moveItem(conn, null, 42, { kind: 'state', state: 'Active' }, fetch)
    assert.ok(!result.ok && result.error.kind === 'writeScope', JSON.stringify(result))
  }
  const forbidden = await moveItem(
    conn,
    null,
    42,
    { kind: 'state', state: 'Active' },
    routedFetch([(c) => c.method === 'PATCH', json({ message: 'TF401027: needs write' }, 403)])
  )
  assert.deepEqual(forbidden, { ok: false, error: { kind: 'writeScope', detail: 'TF401027: needs write' } })
})

test('400 is a rule with the server message, without the PAT or a status prefix', async () => {
  const fetch = routedFetch([
    (c) => c.method === 'PATCH',
    json({ message: `TF401320: Rule Error. Invalid transition ${FAKE_PAT}` }, 400)
  ])
  const result = await moveItem(conn, null, 42, { kind: 'state', state: 'Closed' }, fetch)
  assert.deepEqual(result, { ok: false, error: { kind: 'rule', detail: 'TF401320: Rule Error. Invalid transition ***' } })
  assert.ok(!JSON.stringify(result).includes(FAKE_PAT))
})

test('a 400 on a GET is not a rule, and other PATCH failures keep their mapping', async () => {
  const f1 = routedFetch(['/work/boards/b1', json({ message: 'bad' }, 400)], ['/_apis/wit/workitems/42?fields=', typeAnswer('Story')])
  const r1 = await moveItem(conn, ref, 42, { kind: 'column', columnId: 'c1', done: false }, f1)
  assert.deepEqual(r1, { ok: false, error: { kind: 'server', detail: 'HTTP 400: bad' } })
  const r2 = await moveItem(conn, null, 42, { kind: 'state', state: 'A' }, routedFetch([(c) => c.method === 'PATCH', json({ message: 'x' }, 500)]))
  assert.deepEqual(r2, { ok: false, error: { kind: 'server', detail: 'HTTP 500: x' } })
  const r3 = await moveItem(conn, null, 42, { kind: 'state', state: 'A' }, routedFetch([(c) => c.method === 'PATCH', netError('ENOTFOUND')]))
  assert.deepEqual(r3, { ok: false, error: { kind: 'network', detail: 'ENOTFOUND' } })
})
