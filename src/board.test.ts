import { assert, test } from 'orca/testing'
import { createMetadataCache, type Connection } from './azure'
import { buildBoardWiql, getBoard, listBoards, listTeams } from './board'
import {
  batch,
  boardAnswer,
  child,
  isFieldsBatch,
  isRelationsBatch,
  pr,
  relationsAnswer,
  connectionData,
  FAKE_PAT,
  iterationsAnswer,
  json,
  routedFetch,
  teamFieldAnswer,
  teamsAnswer,
  wiql,
  workItemTypes,
  type Route
} from './fake-fetch'
import type { BoardRef } from './protocol'

const conn: Connection = {
  organization: 'contoso',
  pat: FAKE_PAT,
  hiddenStates: ['Done'],
  allProjects: true,
  projects: [],
  stripAreaPrefix: true
}

const ref: BoardRef = {
  projectId: 'p-1',
  projectName: 'My Project',
  teamId: 't-1',
  teamName: 'Team A',
  boardId: 'b1',
  boardName: 'Stories'
}

const COLUMN = 'WEF_1_Kanban.Column'
const DONE = 'WEF_1_Kanban.Column.Done'
const TEAM = 'https://dev.azure.com/contoso/p-1/t-1/_apis'

const columns: Parameters<typeof boardAnswer>[0] = [
  ['New', 'incoming', 0, false, { Bug: 'New', 'User Story': 'New' }],
  ['Doing', 'inProgress', 3, true, { Bug: 'Active', 'User Story': 'Active' }],
  ['Closed', 'outgoing', 0, false, { Bug: 'Closed', 'User Story': 'Closed', Task: 'Done' }]
]

const typesRoute: Route = [
  '/_apis/wit/workitemtypes',
  workItemTypes(
    ['Bug', 'icon_insect', [['Active', 'InProgress'], ['Removed', 'Removed']]],
    ['User Story', 'icon_book', [['Active', 'InProgress'], ['Removed', 'Removed']]]
  )
]

/** The routes of a working board; `extra` ones win. */
function routes(...extra: Route[]): Route[] {
  return [
    ...extra,
    [isRelationsBatch, relationsAnswer()],
    [`${TEAM}/work/boards/b1`, boardAnswer(columns)],
    ['/work/teamsettings/iterations', iterationsAnswer({ name: 'Sprint 3', path: "My Project\\Sprint '3'" })],
    [
      '/work/teamsettings/teamfieldvalues',
      teamFieldAnswer([
        { value: "My Project\\Team's", includeChildren: true },
        { value: 'My Project\\Shared', includeChildren: false }
      ])
    ],
    ['/_apis/connectionData', connectionData('ME-ID')],
    ['/wit/wiql', wiql(3, 1, 2)],
    [
      isFieldsBatch,
      batch(
        { id: 1, title: '[My Project] One', type: 'Bug', fields: { [COLUMN]: 'Doing', [DONE]: true, 'System.AssignedTo': { displayName: 'Me', id: 'me-id', uniqueName: 'me@x' } } },
        { id: 2, title: 'Two', type: 'User Story', state: 'Removed', fields: { [COLUMN]: 'New' } },
        { id: 3, title: 'Three', type: 'Bug', fields: { [COLUMN]: 'New', [DONE]: false, 'System.AssignedTo': { displayName: 'Ann', id: 'ann', uniqueName: 'a@x' } } }
      )
    ],
    typesRoute
  ]
}

test('board.get without a stored board asks nothing', async () => {
  const fetch = routedFetch()
  assert.deepEqual(await getBoard(conn, null, fetch), { ok: false, error: { kind: 'boardNotConfigured' } })
  assert.equal(fetch.calls.length, 0)
})

test('board.get answers the columns and every item of the current iteration', async () => {
  const fetch = routedFetch(...routes())
  const result = await getBoard(conn, ref, fetch, { cache: createMetadataCache(), meCache: new Map(), now: () => 42 })
  assert.ok(result.ok)
  assert.deepEqual(result.board, ref)
  assert.deepEqual(result.iteration, { name: 'Sprint 3', path: "My Project\\Sprint '3'" })
  assert.equal(result.fetchedAt, 42)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.columns, [
    { id: 'c0', name: 'New', itemLimit: 0, isSplit: false, columnType: 'incoming' },
    { id: 'c1', name: 'Doing', itemLimit: 3, isSplit: true, columnType: 'inProgress' },
    { id: 'c2', name: 'Closed', itemLimit: 0, isSplit: false, columnType: 'outgoing' }
  ])
  // WIQL order is 3, 1, 2; the Removed item 2 is dropped.
  assert.deepEqual(
    result.items.map((i) => [i.id, i.title, i.typeIcon, i.stateCategory, i.boardColumn, i.boardColumnDone, i.assignedTo, i.mine]),
    [
      [3, 'Three', 'icon_insect', 'InProgress', 'New', false, 'Ann', false],
      [1, 'One', 'icon_insect', 'InProgress', 'Doing', true, 'Me', true]
    ]
  )
  assert.equal(result.items[1]!.url, 'https://dev.azure.com/contoso/My%20Project/_workitems/edit/1')

  const post = fetch.calls.find((c) => c.url.includes('/wit/wiql'))!
  assert.match(post.url, /^https:\/\/dev\.azure\.com\/contoso\/p-1\/t-1\/_apis\/wit\/wiql\?\$top=200&api-version=7\.1$/)
  const query = (post.body as { query: string }).query
  assert.match(query, /\[System\.WorkItemType\] IN \('Bug', 'User Story', 'Task'\)/)
  assert.match(query, /\[System\.IterationPath\] = 'My Project\\Sprint ''3'''/)
  assert.match(query, /\(\[System\.AreaPath\] UNDER 'My Project\\Team''s' OR \[System\.AreaPath\] = 'My Project\\Shared'\)/)
  assert.ok(!query.includes('NOT IN'))
  assert.ok(!query.includes('AssignedTo'))

  const batchCall = fetch.calls.find((c) => isFieldsBatch(c))!
  const body = batchCall.body as { ids: number[]; fields: string[] }
  assert.deepEqual(body.ids, [3, 1, 2])
  for (const f of [COLUMN, DONE, 'System.AssignedTo', 'System.Title']) assert.ok(body.fields.includes(f), f)
  assert.equal(new Set(body.fields).size, body.fields.length)
  for (const call of fetch.calls) assert.equal(call.headers.Authorization, `Basic ${btoa(`:${FAKE_PAT}`)}`)
})

test('buildBoardWiql leaves the area clause out when the team has no areas', () => {
  const query = buildBoardWiql(['Bug'], 'P\\S', { field: 'System.AreaPath', values: [] })
  assert.equal(
    query,
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('Bug') AND [System.IterationPath] = 'P\\S' ORDER BY [System.ChangedDate] DESC"
  )
})

test('board.get says when the team has no current iteration', async () => {
  const fetch = routedFetch(...routes(['/work/teamsettings/iterations', iterationsAnswer()]))
  assert.deepEqual(await getBoard(conn, ref, fetch), { ok: false, error: { kind: 'noCurrentIteration' } })
  assert.ok(!fetch.calls.some((c) => c.url.includes('/wit/wiql')))
})

test('a failing own-identity call degrades mine to false and is warned about', async () => {
  const fetch = routedFetch(...routes(['/_apis/connectionData', json({ message: 'no' }, 500)]))
  const warnings: string[] = []
  const result = await getBoard(conn, ref, fetch, { warn: (m) => warnings.push(m) })
  assert.ok(result.ok)
  assert.deepEqual(result.items.map((i) => i.mine), [false, false])
  assert.equal(warnings.length, 1)
  assert.ok(!warnings[0]!.includes(FAKE_PAT))
})

test('the own identity is asked once per organization', async () => {
  const fetch = routedFetch(...routes())
  const meCache = new Map<string, string>()
  assert.ok((await getBoard(conn, ref, fetch, { meCache })).ok)
  assert.ok((await getBoard(conn, ref, fetch, { meCache })).ok)
  assert.equal(fetch.calls.filter((c) => c.url.includes('connectionData')).length, 1)
})

test('a failing required call returns its classified error', async () => {
  const board = routedFetch(...routes([`${TEAM}/work/boards/b1`, json({ message: 'gone' }, 404)]))
  const a = await getBoard(conn, ref, board)
  assert.ok(!a.ok && a.error.kind === 'notFound')
  const field = routedFetch(...routes(['/work/teamsettings/teamfieldvalues', json({}, 403)]))
  const b = await getBoard(conn, ref, field)
  assert.ok(!b.ok && b.error.kind === 'scope')
  const query = routedFetch(...routes(['/wit/wiql', json({ message: `x ${FAKE_PAT}` }, 500)]))
  const c = await getBoard(conn, ref, query)
  assert.ok(!c.ok && c.error.kind === 'server')
  assert.ok(!JSON.stringify(c).includes(FAKE_PAT))
  const bat = routedFetch(...routes([isFieldsBatch, json({}, 401)]))
  const d = await getBoard(conn, ref, bat)
  assert.ok(!d.ok && d.error.kind === 'auth')
})

test('truncated is set when the query returns 200 ids', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => i + 1)
  const fetch = routedFetch(...routes(['/wit/wiql', wiql(...ids)], [isFieldsBatch, batch({ id: 1, title: 'One', type: 'Bug' })]))
  const result = await getBoard(conn, ref, fetch)
  assert.ok(result.ok && result.truncated)
})

test('an empty iteration answers no items and no batch', async () => {
  const fetch = routedFetch(...routes(['/wit/wiql', wiql()]))
  const result = await getBoard(conn, ref, fetch)
  assert.ok(result.ok && result.items.length === 0 && !result.truncated)
  assert.ok(!fetch.calls.some((c) => c.url.includes('workitemsbatch')))
})

test('teams.list sorts by name and reads 401 and 403 as scope', async () => {
  const fetch = routedFetch(['/_apis/projects/p-1/teams', teamsAnswer({ id: 't2', name: 'Zeta' }, { id: 't1', name: 'Alpha' })])
  const result = await listTeams(conn, 'p-1', fetch)
  assert.deepEqual(result, { ok: true, teams: [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Zeta' }] })
  assert.equal(fetch.calls[0]!.url, 'https://dev.azure.com/contoso/_apis/projects/p-1/teams?api-version=7.1&$top=500')
  for (const status of [401, 403]) {
    const denied = await listTeams(conn, 'p-1', routedFetch(['/teams', json({ message: 'no' }, status)]))
    assert.ok(!denied.ok && denied.error.kind === 'scope')
  }
})

test('boards.list keeps the API order', async () => {
  const fetch = routedFetch(['/work/boards', json({ value: [{ id: 'b2', name: 'Stories' }, { id: 'b1', name: 'Epics' }] })])
  const result = await listBoards(conn, 'p-1', 't-1', fetch)
  assert.deepEqual(result, { ok: true, boards: [{ id: 'b2', name: 'Stories' }, { id: 'b1', name: 'Epics' }] })
  assert.equal(fetch.calls[0]!.url, `${TEAM}/work/boards?api-version=7.1`)
})

test('board items carry their children and pull requests, 0 when the relations fail', async () => {
  const links: Route[] = [
    [isRelationsBatch, relationsAnswer([1, [child(10), child(11), pr(7)]], [3, [pr(1), pr(2)]])],
    [(c) => isFieldsBatch(c) && (c.body as { ids: number[] }).ids.includes(10), batch({ id: 10, title: '', state: 'Closed', type: 'Task' }, { id: 11, title: '', state: 'Active', type: 'Task' })]
  ]
  const tasks: Route = ['/_apis/wit/workitemtypes', workItemTypes(
    ['Bug', 'icon_insect', [['Active', 'InProgress'], ['Removed', 'Removed']]],
    ['User Story', 'icon_book', [['Active', 'InProgress'], ['Removed', 'Removed']]],
    ['Task', 'icon_clipboard', [['Active', 'InProgress'], ['Closed', 'Completed']]]
  )]
  const ok = await getBoard(conn, ref, routedFetch(...links, tasks, ...routes()))
  assert.ok(ok.ok)
  assert.deepEqual(ok.items.map((i) => [i.id, i.childrenTotal, i.childrenDone, i.pullRequests]), [[3, 0, 0, 2], [1, 2, 1, 1]])

  const warnings: string[] = []
  const bad = await getBoard(conn, ref, routedFetch([isRelationsBatch, json({}, 500)], ...routes()), { warn: (m) => warnings.push(m) })
  assert.ok(bad.ok)
  assert.deepEqual(bad.items.map((i) => [i.childrenTotal, i.childrenDone, i.pullRequests]), [[0, 0, 0], [0, 0, 0]])
  assert.equal(warnings.filter((w) => w.startsWith('relations')).length, 1)
})

test('getBoard items carry the states of their type', async () => {
  const fetch = routedFetch(
    ['/work/boards/', boardAnswer([['Doing', 'inProgress', 0, false, { Task: 'Active' }]])],
    ['teamsettings/iterations', iterationsAnswer({ name: 'S', path: 'P\\S' })],
    ['teamsettings/teamfieldvalues', teamFieldAnswer([{ value: 'P', includeChildren: true }])],
    ['connectionData', connectionData('me')],
    ['/_apis/wit/wiql', wiql(1)],
    [isFieldsBatch, batch({ id: 1, title: 'A', project: 'P' })],
    [isRelationsBatch, relationsAnswer([1, []])],
    ['/_apis/wit/workitemtypes', workItemTypes(['Task', 'icon_clipboard', [['New', 'Proposed'], ['Active', 'InProgress']]])]
  )
  const result = await getBoard(conn, ref, fetch, { cache: createMetadataCache() })
  assert.ok(result.ok)
  assert.deepEqual(result.items[0]!.states, ['New', 'Active'])
})
