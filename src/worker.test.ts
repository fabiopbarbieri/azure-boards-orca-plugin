// Runs src/worker.ts's activate(orca) over a mock host, with globalThis.fetch swapped for a fake.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import {
  batch,
  boardAnswer,
  connectionData,
  FAKE_PAT,
  fakeFetch,
  html,
  isFieldsBatch,
  isRelationsBatch,
  iterationsAnswer,
  json,
  projectsAnswer,
  relationsAnswer,
  routedFetch,
  teamFieldAnswer,
  teamsAnswer,
  wiql,
  workItemTypes,
  type Answer,
  type Route
} from './fake-fetch'
import * as main from './worker'

const realFetch = globalThis.fetch

function useFetch(...answers: Answer[]) {
  const fetch = fakeFetch(...answers)
  globalThis.fetch = fetch as typeof globalThis.fetch
  return fetch
}

/** Routes for a list: WIQL, batch and the types of the project 'My Project'. */
function useRoutes(...extra: Route[]) {
  const fetch = routedFetch(...extra)
  globalThis.fetch = fetch as typeof globalThis.fetch
  return fetch
}

const typesRoute: Route = [
  '/_apis/wit/workitemtypes',
  workItemTypes(['Task', 'icon_clipboard', [['Active', 'InProgress']]])
]

afterEach(() => {
  globalThis.fetch = realFetch
})

/** The secret as the worker stores it: the PAT bound to the organization that accepted it. */
const storedFor = (organization: string) => JSON.stringify({ organization, pat: FAKE_PAT })
const STORED = storedFor('contoso')
const keyring = { 'secrets.protection': { status: 'os-keyring' } }

/** The PAT must never reach anything the panel or the logs can see. */
function assertNoLeak(
  worker: { logs: readonly string[]; posts: readonly unknown[] },
  ...outputs: unknown[]
) {
  for (const text of [worker.logs, worker.posts, ...outputs].map((v) => JSON.stringify(v))) {
    assert.ok(!text.includes(FAKE_PAT), `PAT leaked in ${text}`)
  }
}

test('reports the config without the PAT', async () => {
  const host = mockHost({
    settings: { organization: 'contoso', groupBy: 'boardColumn', stripAreaPrefix: false, hiddenStates: "Closed, Done" },
    storage: { projects: { all: false, selected: [{ id: 'g1', name: 'Web' }] } },
    secrets: { pat: STORED },
    results: keyring
  })
  const worker = await mountWorker(main, { host })
  const view = await worker.request('config.get')
  assert.deepEqual(view, {
    organization: 'contoso',
    hasPat: true,
    protection: 'os-keyring',
    allProjects: false,
    projects: [{ id: 'g1', name: 'Web' }],
    groupBy: 'boardColumn',
    stripAreaPrefix: false,
    hiddenStates: ['Closed', 'Done'],
    refreshMinutes: 5,
    board: null
  })
  assertNoLeak(worker, view)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('config.get defaults: every project, grouped by state, area prefix stripped', async () => {
  const host = mockHost({ settings: { organization: 'contoso' }, results: keyring })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('config.get'), {
    organization: 'contoso',
    hasPat: false,
    protection: 'os-keyring',
    allProjects: true,
    projects: [],
    groupBy: 'state',
    stripAreaPrefix: true,
    hiddenStates: [],
    refreshMinutes: 5,
    board: null
  })
  await worker.deactivate()
})

test('an invalid stored groupBy or filter reads as the defaults', async () => {
  const host = mockHost({
    settings: { organization: 'contoso', groupBy: 'weird' },
    storage: { projects: 'junk' },
    results: keyring
  })
  const worker = await mountWorker(main, { host })
  const view = await worker.request('config.get')
  assert.deepEqual([view.groupBy, view.allProjects, view.projects], ['state', true, []])
  await worker.deactivate()
})

test('lists with the stored settings and PAT', async () => {
  const fetch = useRoutes(
    ['/_apis/wit/wiql', wiql(7)],
    ['/_apis/wit/workitemsbatch', batch({ id: 7, title: '[My Project] Seven', column: 'Doing' })],
    typesRoute
  )
  const host = mockHost({
    settings: { organization: 'contoso', hiddenStates: 'Closed' },
    secrets: { pat: STORED }
  })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('items.list')
  assert.ok(result.ok)
  assert.deepEqual(
    result.items.map((i) => [i.id, i.title, i.typeIcon, i.stateCategory, i.boardColumn]),
    [[7, 'Seven', 'icon_clipboard', 'InProgress', 'Doing']]
  )
  assert.match(fetch.calls[0]!.url, /^https:\/\/dev\.azure\.com\/contoso\/_apis\/wit\/wiql/)
  for (const call of fetch.calls) {
    assert.equal(call.headers.Authorization, `Basic ${btoa(`:${FAKE_PAT}`)}`)
  }
  assert.match((fetch.calls[0]!.body as { query: string }).query, /NOT IN \('Closed'\)/)
  assertNoLeak(worker, result)
  await worker.deactivate()
})

test('asks for setup when nothing is stored', async () => {
  const fetch = useFetch()
  const worker = await mountWorker(main, { host: mockHost() })
  assert.deepEqual(await worker.request('items.list'), { ok: false, error: { kind: 'notConfigured' } })
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()
})

test('saves the organization and PAT only after Azure DevOps accepts them', async () => {
  useFetch(wiql())
  const host = mockHost({ results: keyring })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('config.save', {
    organization: ' https://dev.azure.com/Contoso/ ',
    pat: FAKE_PAT
  })
  assert.ok(result.ok)
  assert.equal(host.data().secrets.pat, storedFor('contoso'))
  assert.equal(host.data().settings.organization, 'Contoso')
  const changed = worker.posts.filter((p) => p.event === 'config.changed')
  assert.ok(changed.length >= 1)
  assert.deepEqual(changed.at(-1)!.payload, {
    organization: 'Contoso',
    hasPat: true,
    protection: 'os-keyring',
    allProjects: true,
    projects: [],
    groupBy: 'state',
    stripAreaPrefix: true,
    hiddenStates: [],
    refreshMinutes: 5,
    board: null
  })
  assertNoLeak(worker, result)
  await worker.deactivate()
})

test('keeps nothing when the PAT is refused', async () => {
  useFetch(html(401))
  const host = mockHost({ results: keyring })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('config.save', { organization: 'contoso', pat: FAKE_PAT })
  assert.deepEqual(result, { ok: false, error: { kind: 'auth', detail: 'HTTP 401' } })
  assert.equal(host.data().secrets.pat, undefined)
  assert.equal(host.data().settings.organization ?? '', '')
  assertNoLeak(worker, result)
  await worker.deactivate()
})

test('refuses a new PAT when Orca has no keyring, before any request', async () => {
  const fetch = useFetch()
  const host = mockHost({ results: { 'secrets.protection': { status: 'unavailable' } } })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('config.save', { organization: 'contoso', pat: FAKE_PAT })
  assert.deepEqual(result, { ok: false, error: { kind: 'secretsUnavailable' } })
  assert.equal(fetch.calls.length, 0)
  assert.equal(host.data().secrets.pat, undefined)
  await worker.deactivate()
})

test('saving the same organization again keeps the stored PAT', async () => {
  const fetch = useFetch(wiql())
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('config.save', { organization: 'CONTOSO' })
  assert.ok(result.ok)
  assert.equal(fetch.calls[0]!.headers.Authorization, `Basic ${btoa(`:${FAKE_PAT}`)}`)
  assert.equal(host.data().secrets.pat, STORED)
  await worker.deactivate()
})

test('never sends the stored PAT to another organization from the panel', async () => {
  const fetch = useFetch()
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('config.save', { organization: 'fabrikam' })
  assert.deepEqual(result, { ok: false, error: { kind: 'notConfigured' } })
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()
})

test('never sends the stored PAT to an organization changed in Settings', async () => {
  const fetch = useFetch()
  const host = mockHost({ settings: { organization: 'fabrikam' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  assert.equal((await worker.request('config.get')).hasPat, false)
  assert.deepEqual(await worker.request('items.list'), { ok: false, error: { kind: 'notConfigured' } })
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()
})

test('reads an unreadable secret as no PAT', async () => {
  const fetch = useFetch()
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: 'not json' } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('items.list'), { ok: false, error: { kind: 'notConfigured' } })
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()
})

test('rejects what is not an organization', async () => {
  const fetch = useFetch()
  const worker = await mountWorker(main, {
    host: mockHost({ settings: { organization: 'https://example.com/x' }, secrets: { pat: STORED } })
  })
  const typed = await worker.request('config.save', { organization: 'not an org', pat: FAKE_PAT })
  assert.deepEqual(typed, { ok: false, error: { kind: 'invalidOrganization' } })
  assert.deepEqual(await worker.request('items.list'), { ok: false, error: { kind: 'invalidOrganization' } })
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()
})

test('forgets the PAT', async () => {
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  const view = await worker.request('pat.clear')
  assert.equal(view.hasPat, false)
  assert.equal(host.data().secrets.pat, undefined)
  await worker.deactivate()
})

test('the list filters by the stored projects', async () => {
  const fetch = useRoutes(['/_apis/wit/wiql', wiql()])
  const host = mockHost({
    settings: { organization: 'contoso' },
    storage: { projects: { all: false, selected: [{ id: 'g1', name: "O'Neil" }] } },
    secrets: { pat: STORED }
  })
  const worker = await mountWorker(main, { host })
  assert.ok((await worker.request('items.list')).ok)
  assert.match((fetch.calls[0]!.body as { query: string }).query, /\[System\.TeamProject\] IN \('O''Neil'\)/)
  await worker.deactivate()
})

test('an empty selection lists nothing and asks nothing', async () => {
  const fetch = useFetch()
  const host = mockHost({
    settings: { organization: 'contoso' },
    storage: { projects: { all: false, selected: [] } },
    secrets: { pat: STORED }
  })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('items.list')
  assert.ok(result.ok && result.items.length === 0)
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()
})

test('the area prefix setting decides the title, and the types are cached between lists', async () => {
  const fetch = useRoutes(
    ['/_apis/wit/wiql', wiql(1)],
    [
      '/_apis/wit/workitemsbatch',
      batch({ id: 1, title: '[Operações Web] - Ajustar', area: 'Portal\\Operacoes Web' })
    ],
    typesRoute
  )
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  const first = await worker.request('items.list')
  assert.ok(first.ok && first.items[0]!.title === 'Ajustar')
  await worker.request('prefs.set', { stripAreaPrefix: false })
  const second = await worker.request('items.list')
  assert.ok(second.ok && second.items[0]!.title === '[Operações Web] - Ajustar')
  assert.equal(fetch.calls.filter((c) => c.url.includes('workitemtypes')).length, 1)
  await worker.deactivate()
})

test('a metadata failure keeps the list and is logged without the PAT', async () => {
  useRoutes(
    ['/_apis/wit/wiql', wiql(1)],
    ['/_apis/wit/workitemsbatch', batch({ id: 1, title: 'One' })],
    ['/_apis/wit/workitemtypes', json({ message: `denied ${FAKE_PAT}` }, 403)]
  )
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('items.list')
  assert.ok(result.ok && result.items[0]!.typeIcon === '' && result.items[0]!.stateCategory === '')
  assert.equal(worker.logs.filter((l) => l.includes('type metadata')).length, 1)
  assertNoLeak(worker, result)
  await worker.deactivate()
})

test('prefs.set stores the projects and the preferences, and posts the new view', async () => {
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED }, results: keyring })
  const worker = await mountWorker(main, { host })
  const view = await worker.request('prefs.set', {
    allProjects: false,
    projects: [
      { id: 'g1', name: 'Web' },
      { id: 'g1', name: 'Web' },
      { id: '', name: 'Api' }
    ],
    groupBy: 'boardColumn',
    stripAreaPrefix: false
  })
  assert.deepEqual(view, {
    organization: 'contoso',
    hasPat: true,
    protection: 'os-keyring',
    allProjects: false,
    projects: [
      { id: 'g1', name: 'Web' },
      { id: 'Api', name: 'Api' }
    ],
    groupBy: 'boardColumn',
    stripAreaPrefix: false,
    hiddenStates: [],
    refreshMinutes: 5,
    board: null
  })
  const data = host.data()
  assert.deepEqual(data.storage.projects, {
    all: false,
    selected: [
      { id: 'g1', name: 'Web' },
      { id: 'Api', name: 'Api' }
    ]
  })
  assert.equal(data.settings.groupBy, 'boardColumn')
  assert.equal(data.settings.stripAreaPrefix, false)
  assert.deepEqual(worker.posts.filter((p) => p.event === 'config.changed').at(-1)!.payload, view)

  // A partial update leaves the rest alone.
  const partial = await worker.request('prefs.set', { groupBy: 'none' })
  assert.deepEqual([partial.groupBy, partial.allProjects, partial.stripAreaPrefix], ['none', false, false])
  assertNoLeak(worker, view)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('prefs.set refuses invalid values with invalid_params and writes nothing', async () => {
  const host = mockHost({ settings: { organization: 'contoso' }, results: keyring })
  const worker = await mountWorker(main, { host })
  for (const bad of [
    { groupBy: 'weird', allProjects: false },
    { stripAreaPrefix: 'yes' },
    { allProjects: 1 },
    { projects: 'Web' }
  ]) {
    await assert.rejects(
      () => worker.request('prefs.set', bad as never),
      (error: unknown) => (error as { code?: string }).code === 'invalid_params'
    )
  }
  assert.equal(host.data().storage.projects, undefined)
  assert.equal(host.data().settings.groupBy ?? 'state', 'state')
  await worker.deactivate()
})

test('projects.list answers the projects and renames the stored selection by id', async () => {
  const fetch = useRoutes([
    '/_apis/projects',
    projectsAnswer([
      { id: 'g1', name: 'Web Renamed' },
      { id: 'g2', name: 'Api' },
      { id: 'g3', name: 'Gone', state: 'deleting' }
    ])
  ])
  const host = mockHost({
    settings: { organization: 'contoso' },
    storage: {
      projects: {
        all: false,
        selected: [
          { id: 'g1', name: 'Web' },
          { id: 'g9', name: 'Not listed' }
        ]
      }
    },
    secrets: { pat: STORED }
  })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('projects.list')
  assert.deepEqual(result, {
    ok: true,
    complete: true,
    projects: [
      { id: 'g2', name: 'Api' },
      { id: 'g1', name: 'Web Renamed' }
    ]
  })
  assert.deepEqual(host.data().storage.projects, {
    all: false,
    selected: [
      { id: 'g1', name: 'Web Renamed' },
      { id: 'g9', name: 'Not listed' }
    ]
  })
  const view = worker.posts.filter((p) => p.event === 'config.changed').at(-1)!.payload as { projects: unknown }
  assert.deepEqual(view.projects, (host.data().storage.projects as { selected: unknown }).selected)
  assert.equal(fetch.calls[0]!.headers.Authorization, `Basic ${btoa(`:${FAKE_PAT}`)}`)
  assertNoLeak(worker, result)
  await worker.deactivate()
})

test('projects.list without a rename posts and writes nothing', async () => {
  useRoutes(['/_apis/projects', projectsAnswer([{ id: 'g1', name: 'Web' }])])
  const host = mockHost({
    settings: { organization: 'contoso' },
    storage: { projects: { all: false, selected: [{ id: 'g1', name: 'Web' }] } },
    secrets: { pat: STORED }
  })
  const worker = await mountWorker(main, { host })
  await worker.request('projects.list')
  assert.equal(worker.posts.filter((p) => p.event === 'config.changed').length, 0)
  await worker.deactivate()
})

test('projects.list falls back to the assigned items when the scope is missing', async () => {
  useRoutes(
    ['/_apis/projects', html(401)],
    ['/_apis/wit/wiql', wiql(1, 2)],
    [
      '/_apis/wit/workitemsbatch',
      batch({ id: 1, title: 'a', project: 'Web' }, { id: 2, title: 'b', project: 'Api' })
    ]
  )
  const host = mockHost({
    settings: { organization: 'contoso' },
    storage: { projects: { all: false, selected: [{ id: 'g1', name: 'Web' }] } },
    secrets: { pat: STORED }
  })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('projects.list')
  assert.deepEqual(result, {
    ok: true,
    complete: false,
    projects: [
      { id: 'Api', name: 'Api' },
      { id: 'Web', name: 'Web' }
    ]
  })
  // The stored selection is left alone: the fallback has no ids to rename by.
  assert.deepEqual(host.data().storage.projects, { all: false, selected: [{ id: 'g1', name: 'Web' }] })
  assertNoLeak(worker, result)
  await worker.deactivate()
})

test('projects.list needs a PAT for the organization and never sends another one', async () => {
  const fetch = useFetch()
  const host = mockHost({ settings: { organization: 'fabrikam' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('projects.list'), { ok: false, error: { kind: 'notConfigured' } })
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()
})

test('the PAT never reaches logs, posts or outputs, even when the server echoes it', async () => {
  useRoutes(
    ['/_apis/projects', json({ message: `bad ${FAKE_PAT}` }, 500)],
    ['/_apis/wit/wiql', json({ message: `bad ${FAKE_PAT}` }, 500)]
  )
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED }, results: keyring })
  const worker = await mountWorker(main, { host })
  const outputs = [
    await worker.request('projects.list'),
    await worker.request('items.list'),
    await worker.request('config.save', { organization: 'contoso', pat: FAKE_PAT }),
    await worker.request('config.get'),
    await worker.request('prefs.set', { groupBy: 'none' })
  ]
  assertNoLeak(worker, ...outputs)
  assert.ok(worker.logs.length > 0)
  await worker.deactivate()
})

test('another organization starts from every project, and the old filter is not used to test it', async () => {
  const fetch = useRoutes(['/_apis/wit/wiql', wiql()])
  const host = mockHost({
    settings: { organization: 'contoso' },
    storage: { projects: { all: false, selected: [{ id: 'g1', name: 'Web' }] } },
    results: keyring
  })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('config.save', { organization: 'fabrikam', pat: FAKE_PAT })
  assert.ok(result.ok)
  assert.ok(!(fetch.calls[0]!.body as { query: string }).query.includes('TeamProject'))
  assert.deepEqual(host.data().storage.projects, { all: true, selected: [] })
  assert.equal(host.data().settings.organization, 'fabrikam')
  await worker.deactivate()
})

test('saving the same organization keeps the project filter', async () => {
  const fetch = useRoutes(['/_apis/wit/wiql', wiql()])
  const filter = { all: false, selected: [{ id: 'g1', name: 'Web' }] }
  const host = mockHost({
    settings: { organization: 'contoso' },
    storage: { projects: filter },
    secrets: { pat: STORED }
  })
  const worker = await mountWorker(main, { host })
  assert.ok((await worker.request('config.save', { organization: 'Contoso' })).ok)
  assert.match((fetch.calls[0]!.body as { query: string }).query, /IN \('Web'\)/)
  assert.deepEqual(host.data().storage.projects, filter)
  await worker.deactivate()
})

// ---- the team board ----

const BOARD_REF = {
  projectId: 'p-1',
  projectName: 'My Project',
  teamId: 't-1',
  teamName: 'Team A',
  boardId: 'b1',
  boardName: 'Stories'
}

function boardRoutes(...extra: Route[]): Route[] {
  return [
    ...extra,
    [isRelationsBatch, relationsAnswer()],
    ['/work/boards/b1', boardAnswer([['New', 'incoming', 0, false, { Task: 'New' }], ['Done', 'outgoing', 0, false, { Task: 'Done' }]])],
    ['/work/teamsettings/iterations', iterationsAnswer({ name: 'Sprint 1', path: 'My Project\\Sprint 1' })],
    ['/work/teamsettings/teamfieldvalues', teamFieldAnswer([{ value: 'My Project', includeChildren: true }])],
    ['/_apis/connectionData', connectionData('me')],
    ['/wit/wiql', wiql(1)],
    [isFieldsBatch, batch({ id: 1, title: 'One', fields: { 'WEF_1_Kanban.Column': 'New', 'System.AssignedTo': { displayName: 'Me', id: 'ME' } } })],
    typesRoute
  ]
}

test('board.get without a stored board asks nothing, and without a PAT asks for setup', async () => {
  const fetch = useRoutes()
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('board.get'), { ok: false, error: { kind: 'boardNotConfigured' } })
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()

  const bare = mockHost({ settings: { organization: 'contoso' }, storage: { board: BOARD_REF } })
  const w2 = await mountWorker(main, { host: bare })
  assert.deepEqual(await w2.request('board.get'), { ok: false, error: { kind: 'notConfigured' } })
  assert.equal(fetch.calls.length, 0)
  await w2.deactivate()
})

test('board.get answers the stored board, logs failures without the PAT', async () => {
  const fetch = useRoutes(...boardRoutes())
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED }, storage: { board: BOARD_REF } })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('board.get')
  assert.ok(result.ok)
  assert.deepEqual(result.board, BOARD_REF)
  assert.deepEqual(result.items.map((i) => [i.id, i.boardColumn, i.assignedTo, i.mine]), [[1, 'New', 'Me', true]])
  assert.deepEqual(result.columns.map((c) => c.name), ['New', 'Done'])
  assert.ok(fetch.calls.every((c) => c.url.startsWith('https://dev.azure.com/contoso/')))
  assertNoLeak(worker, result)
  await worker.request('board.get')
  assert.equal(fetch.calls.filter((c) => c.url.includes('connectionData')).length, 1)
  await worker.deactivate()

  useRoutes(...boardRoutes(['/work/boards/b1', json({ message: `no ${FAKE_PAT}` }, 500)]))
  const w2 = await mountWorker(main, { host: mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED }, storage: { board: BOARD_REF } }) })
  const failed = await w2.request('board.get')
  assert.ok(!failed.ok && failed.error.kind === 'server')
  assert.ok(w2.logs.length > 0)
  assertNoLeak(w2, failed)
  await w2.deactivate()
})

test('a malformed stored board reads as none', async () => {
  const host = mockHost({
    settings: { organization: 'contoso' },
    secrets: { pat: STORED },
    storage: { board: { ...BOARD_REF, boardId: '' } },
    results: keyring
  })
  const worker = await mountWorker(main, { host })
  assert.equal((await worker.request('config.get')).board, null)
  await worker.deactivate()
})

test('teams.list and boards.list use the stored PAT only for the stored organization', async () => {
  const fetch = useRoutes(
    ['/_apis/projects/p-1/teams', teamsAnswer({ id: 't1', name: 'B' }, { id: 't2', name: 'A' })],
    ['/work/boards', json({ value: [{ id: 'b1', name: 'Stories' }] })]
  )
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  const teams = await worker.request('teams.list', { projectId: 'p-1' })
  assert.ok(teams.ok)
  assert.deepEqual(teams.teams.map((t) => t.name), ['A', 'B'])
  const boards = await worker.request('boards.list', { projectId: 'p-1', teamId: 't-1' })
  assert.deepEqual(boards, { ok: true, boards: [{ id: 'b1', name: 'Stories' }] })
  await assert.rejects(
    () => worker.request('teams.list', { projectId: '' }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_params'
  )
  await worker.deactivate()

  // The organization was changed in Settings: the PAT of another one is never sent.
  const before = fetch.calls.length
  const other = await mountWorker(main, { host: mockHost({ settings: { organization: 'fabrikam' }, secrets: { pat: STORED } }) })
  assert.deepEqual(await other.request('teams.list', { projectId: 'p-1' }), { ok: false, error: { kind: 'notConfigured' } })
  assert.deepEqual(await other.request('boards.list', { projectId: 'p-1', teamId: 't' }), { ok: false, error: { kind: 'notConfigured' } })
  const stored = mockHost({ settings: { organization: 'fabrikam' }, secrets: { pat: STORED }, storage: { board: BOARD_REF } })
  const w3 = await mountWorker(main, { host: stored })
  assert.deepEqual(await w3.request('board.get'), { ok: false, error: { kind: 'notConfigured' } })
  assert.equal(fetch.calls.length, before)
  await other.deactivate()
  await w3.deactivate()
})

test('teams.list maps a 403 to scope', async () => {
  useRoutes(['/teams', json({ message: 'denied' }, 403)])
  const worker = await mountWorker(main, { host: mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } }) })
  const result = await worker.request('teams.list', { projectId: 'p-1' })
  assert.ok(!result.ok && result.error.kind === 'scope')
  assertNoLeak(worker, result)
  await worker.deactivate()
})

test('prefs.set stores, clears and validates the board', async () => {
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED }, results: keyring })
  const worker = await mountWorker(main, { host })
  const set = await worker.request('prefs.set', { board: { ...BOARD_REF, boardName: ' Stories ', extra: 1 } as never })
  assert.deepEqual(set.board, BOARD_REF)
  assert.deepEqual(host.data().storage.board, BOARD_REF)
  assert.deepEqual(worker.posts.filter((p) => p.event === 'config.changed').at(-1)!.payload, set)
  for (const bad of [{ ...BOARD_REF, teamId: '' }, { ...BOARD_REF, teamName: 3 }, 'x', { projectId: 'p' }]) {
    await assert.rejects(
      () => worker.request('prefs.set', { board: bad } as never),
      (error: unknown) => (error as { code?: string }).code === 'invalid_params'
    )
  }
  assert.deepEqual(host.data().storage.board, BOARD_REF)
  // Other prefs leave it alone; null clears it.
  assert.deepEqual((await worker.request('prefs.set', { groupBy: 'none' })).board, BOARD_REF)
  assert.equal((await worker.request('prefs.set', { board: null })).board, null)
  assert.equal(host.data().storage.board, undefined)
  await worker.deactivate()
})

test('saving another organization clears the board, the same one keeps it', async () => {
  useRoutes(['/_apis/wit/wiql', wiql()])
  const host = mockHost({
    settings: { organization: 'contoso' },
    secrets: { pat: STORED },
    storage: { board: BOARD_REF },
    results: keyring
  })
  const worker = await mountWorker(main, { host })
  assert.ok((await worker.request('config.save', { organization: 'Contoso' })).ok)
  assert.deepEqual(host.data().storage.board, BOARD_REF)
  assert.ok((await worker.request('config.save', { organization: 'fabrikam', pat: FAKE_PAT })).ok)
  assert.equal(host.data().storage.board, undefined)
  assert.equal((await worker.request('config.get')).board, null)
  await worker.deactivate()
})

const MOVE_BOARD = boardAnswer([
  ['New', 'incoming', 0, false, { Task: 'New' }],
  ['Doing', 'inProgress', 0, true, { Task: 'Active' }]
])
const isPatch = (c: { method: string }) => c.method === 'PATCH'

test('item.move to a state PATCHes the item', async () => {
  const fetch = useRoutes([isPatch, json({ id: 5 })])
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('item.move', { id: 5, target: { kind: 'state', state: 'Active' } })
  assert.deepEqual(result, { ok: true })
  assert.equal(fetch.calls[0]!.url, 'https://dev.azure.com/contoso/_apis/wit/workitems/5?api-version=7.1')
  assert.deepEqual(fetch.calls[0]!.body, [{ op: 'add', path: '/fields/System.State', value: 'Active' }])
  assertNoLeak(worker, result)
  await worker.deactivate()
})

test('item.move to a column uses the stored board', async () => {
  const fetch = useRoutes(
    ['/work/boards/b1', MOVE_BOARD],
    ['/_apis/wit/workitems/5?fields=', json({ id: 5, fields: { 'System.WorkItemType': 'Task' } })],
    [isPatch, json({ id: 5 })]
  )
  const host = mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED }, storage: { board: BOARD_REF } })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('item.move', { id: 5, target: { kind: 'column', columnId: 'c1', done: true } })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(fetch.calls.find(isPatch)!.body, [
    { op: 'add', path: '/fields/WEF_1_Kanban.Column', value: 'Doing' },
    { op: 'add', path: '/fields/WEF_1_Kanban.Column.Done', value: true },
    { op: 'add', path: '/fields/System.State', value: 'Active' }
  ])
  await worker.deactivate()
})

test('item.move without a board, or without credentials, asks nothing', async () => {
  const fetch = useRoutes()
  const column = { id: 5, target: { kind: 'column', columnId: 'c1', done: false } } as const
  const worker = await mountWorker(main, { host: mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } }) })
  assert.deepEqual(await worker.request('item.move', column), { ok: false, error: { kind: 'boardNotConfigured' } })
  await worker.deactivate()
  const bare = await mountWorker(main, { host: mockHost({ settings: { organization: 'contoso' } }) })
  assert.deepEqual(await bare.request('item.move', column), { ok: false, error: { kind: 'notConfigured' } })
  await bare.deactivate()
  const bad = await mountWorker(main, { host: mockHost({ settings: { organization: 'not an org!' }, secrets: { pat: STORED } }) })
  assert.deepEqual(await bad.request('item.move', column), { ok: false, error: { kind: 'invalidOrganization' } })
  await bad.deactivate()
  assert.equal(fetch.calls.length, 0)
})

test('item.move refuses invalid input with invalid_params and asks nothing', async () => {
  const fetch = useRoutes()
  const worker = await mountWorker(main, { host: mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } }) })
  for (const input of [
    { id: 0, target: { kind: 'state', state: 'A' } },
    { id: 1.2, target: { kind: 'state', state: 'A' } },
    { id: 1, target: { kind: 'state', state: ' ' } },
    { id: 1, target: { kind: 'column', columnId: 'c' } },
    { id: 1, target: { kind: 'x' } },
    { id: 1 }
  ]) {
    await assert.rejects(
      () => worker.request('item.move', input as never),
      (error: unknown) => (error as { code?: string }).code === 'invalid_params'
    )
  }
  assert.equal(fetch.calls.length, 0)
  await worker.deactivate()
})

test('item.move maps 401/403 to writeScope and 400 to rule, logging without the PAT', async () => {
  const cases: [Response, string, string | undefined][] = [
    [json({}, 401), 'writeScope', 'HTTP 401'],
    [json({ message: `needs write ${FAKE_PAT}` }, 403), 'writeScope', 'needs write ***'],
    [json({ message: `TF401320: invalid transition ${FAKE_PAT}` }, 400), 'rule', 'TF401320: invalid transition ***']
  ]
  for (const [answer, kind, detail] of cases) {
    useRoutes([isPatch, answer])
    const worker = await mountWorker(main, { host: mockHost({ settings: { organization: 'contoso' }, secrets: { pat: STORED } }) })
    const result = await worker.request('item.move', { id: 5, target: { kind: 'state', state: 'Closed' } })
    assert.deepEqual(result, { ok: false, error: { kind, detail } })
    assert.ok(worker.logs.some((l) => l.startsWith(`move failed: ${kind} (`)), worker.logs.join('|'))
    assertNoLeak(worker, result)
    await worker.deactivate()
  }
})
