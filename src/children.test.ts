import { assert, test } from 'orca/testing'
import { createMetadataCache, type Connection } from './azure'
import { listChildren } from './children'
import {
  batch,
  child,
  connectionData,
  FAKE_PAT,
  json,
  pr,
  relationsAnswer,
  routedFetch,
  workItemTypes,
  type Call,
  type Route
} from './fake-fetch'

const conn: Connection = {
  organization: 'contoso',
  pat: FAKE_PAT,
  hiddenStates: [],
  allProjects: true,
  projects: [],
  stripAreaPrefix: true
}

const types: Route = [
  '/_apis/wit/workitemtypes',
  workItemTypes(['Task', 'icon_clipboard', [['New', 'Proposed'], ['Active', 'InProgress'], ['Resolved', 'Resolved'], ['Done', 'Completed'], ['Removed', 'Removed']]])
]

const idsOf = (call: Call) => (call.body as { ids?: number[] } | undefined)?.ids ?? []
const isRelations = (call: Call) => (call.body as { $expand?: string } | undefined)?.$expand === 'relations'
/** The batch that reads the children's fields (it asks for titles, unlike the counters' one). */
const isTitles = (call: Call) => !!(call.body as { fields?: string[] } | undefined)?.fields?.includes('System.Title')
const forIds = (match: (ids: number[]) => boolean) => (call: Call) => isRelations(call) && match(idsOf(call))

/** Item 1234 has children 1 to 6 and 99 (the batch omits 99); child 5 has children of its own. */
function routes(...extra: Route[]): Route[] {
  return [
    ...extra,
    [forIds((ids) => ids.length === 1 && ids[0] === 1234), relationsAnswer([1234, [child(4), child(1), child(2), child(3), child(99), child(5), child(6)]])],
    [
      forIds((ids) => ids.includes(1)),
      relationsAnswer([1, [child(10), child(11)]], [2, [pr(7)]], [3, []], [4, []])
    ],
    [(c) => !isRelations(c) && !isTitles(c) && idsOf(c).includes(10), batch({ id: 10, title: 'Sub', state: 'Done' }, { id: 11, title: 'Sub 2', state: 'Removed' })],
    [
      isTitles,
      batch(
        { id: 4, title: '[My Project] Draft', state: 'New', fields: { 'System.AssignedTo': { displayName: 'Ana', id: 'ME-ID' } } },
        { id: 3, title: 'Closed one', state: 'Done' },
        { id: 1, title: 'Working', state: 'Active', column: 'Doing', columnDone: true },
        { id: 2, title: 'Gone', state: 'Removed' },
        { id: 6, title: 'Also active', state: 'Active', fields: { 'System.AssignedTo': 'Bob' } },
        { id: 5, title: 'Unknown state', state: 'Weird' }
      )
    ],
    ['/_apis/connectionData', connectionData('me-id')],
    types
  ]
}

test('listChildren orders by state category then id, drops Removed and skips omitted children', async () => {
  const fetch = routedFetch(...routes())
  const result = await listChildren(conn, 1234, fetch, { cache: createMetadataCache(), meCache: new Map() })
  assert.ok(result.ok)
  // Proposed 4, InProgress 1 and 6, Completed 3, unknown 5 last. Removed 2 is dropped; 99 was omitted.
  assert.deepEqual(
    result.items.map((i) => [i.id, i.title, i.stateCategory, i.assignedTo, i.mine, i.boardColumn, i.boardColumnDone]),
    [
      [4, 'Draft', 'Proposed', 'Ana', true, '', false],
      [1, 'Working', 'InProgress', '', false, 'Doing', true],
      [6, 'Also active', 'InProgress', 'Bob', false, '', false],
      [3, 'Closed one', 'Completed', '', false, '', false],
      [5, 'Unknown state', '', '', false, '', false]
    ]
  )
  assert.equal(result.items[0]!.typeIcon, 'icon_clipboard')
  assert.deepEqual(result.items[0]!.states, ['New', 'Active', 'Resolved', 'Done', 'Removed'])
  assert.equal(result.items[0]!.url, 'https://dev.azure.com/contoso/My%20Project/_workitems/edit/4')
  const ask = fetch.calls.find(isTitles)!
  assert.deepEqual((ask.body as { ids: number[] }).ids, [4, 1, 2, 3, 99, 5, 6])
  assert.ok((ask.body as { fields: string[] }).fields.includes('System.AssignedTo'))
})

test('listChildren fills the counters of each child', async () => {
  const fetch = routedFetch(...routes())
  const result = await listChildren(conn, 1234, fetch, { cache: createMetadataCache(), meCache: new Map() })
  assert.ok(result.ok)
  const one = result.items.find((i) => i.id === 1)!
  // Child 10 is Completed, child 11 Removed (not counted).
  assert.deepEqual([one.childrenTotal, one.childrenDone, one.pullRequests], [1, 1, 0])
  assert.deepEqual([result.items.find((i) => i.id === 4)!.childrenTotal, result.items.find((i) => i.id === 3)!.pullRequests], [0, 0])
})

test('listChildren answers an empty list for an item without children, or an omitted item', async () => {
  const none = routedFetch([isRelations, relationsAnswer([1234, [pr(1)]])])
  assert.deepEqual(await listChildren(conn, 1234, none), { ok: true, items: [] })
  assert.equal(none.calls.length, 1)
  const omitted = routedFetch([isRelations, json({ count: 0, value: [] })])
  assert.deepEqual(await listChildren(conn, 1234, omitted), { ok: true, items: [] })
})

test('listChildren maps errors to ListError and never leaks the PAT', async () => {
  const first = routedFetch([isRelations, json({ message: `no ${FAKE_PAT}` }, 403)])
  assert.deepEqual(await listChildren(conn, 1234, first), { ok: false, error: { kind: 'scope', detail: 'no ***' } })
  const second = routedFetch(...routes([isTitles, json({}, 500)]))
  const result = await listChildren(conn, 1234, second)
  assert.deepEqual(result, { ok: false, error: { kind: 'server', detail: 'HTTP 500: {}' } })
  assert.ok(!JSON.stringify(result).includes(FAKE_PAT))
})

test('listChildren still answers when the own identity cannot be read', async () => {
  const warnings: string[] = []
  const fetch = routedFetch(...routes(['/_apis/connectionData', json({}, 403)]))
  const result = await listChildren(conn, 1234, fetch, { meCache: new Map(), warn: (m) => warnings.push(m) })
  assert.ok(result.ok)
  assert.ok(result.items.every((i) => !i.mine))
  assert.equal(warnings.length, 1)
})
