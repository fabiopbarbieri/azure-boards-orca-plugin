import { assert, test } from 'orca/testing'
import {
  authorization,
  buildWiql,
  cleanTitle,
  createMetadataCache,
  listAssigned,
  listProjects,
  parseOrganization,
  parseStates,
  request,
  toItem,
  type Connection
} from './azure'
import {
  batch,
  child,
  FAKE_PAT,
  isFieldsBatch,
  isRelationsBatch,
  pr,
  relationsAnswer,
  fakeFetch,
  html,
  json,
  netError,
  projectsAnswer,
  routedFetch,
  wiql,
  workItemTypes
} from './fake-fetch'

const conn = (over: Partial<Connection> = {}): Connection => ({
  organization: 'contoso',
  pat: FAKE_PAT,
  hiddenStates: ['Closed', 'Done', 'Removed'],
  allProjects: true,
  projects: [],
  stripAreaPrefix: true,
  ...over
})

test('reads the organization from a name or a URL', () => {
  assert.equal(parseOrganization(' contoso '), 'contoso')
  assert.equal(parseOrganization('Contoso-Dev'), 'Contoso-Dev')
  assert.equal(parseOrganization('https://dev.azure.com/contoso'), 'contoso')
  assert.equal(parseOrganization('https://dev.azure.com/contoso/Web/_workitems/edit/12'), 'contoso')
  assert.equal(parseOrganization('dev.azure.com/contoso/'), 'contoso')
  assert.equal(parseOrganization('https://contoso.visualstudio.com/Web'), 'contoso')
  assert.equal(parseOrganization('https://example.com/contoso'), null)
  assert.equal(parseOrganization('http://dev.azure.com/contoso'), null)
  assert.equal(parseOrganization('https://user:pw@dev.azure.com/contoso'), null)
  assert.equal(parseOrganization('https://dev.azure.com/'), null)
  assert.equal(parseOrganization('-bad'), null)
  assert.equal(parseOrganization('has space'), null)
  assert.equal(parseOrganization(''), null)
  // A bad percent escape is not an organization, not a crash.
  assert.equal(parseOrganization('dev.azure.com/%E0'), null)
})

test('parses the hidden states setting', () => {
  assert.deepEqual(parseStates(' Closed, Done ,,Removed '), ['Closed', 'Done', 'Removed'])
  assert.deepEqual(parseStates(''), [])
  assert.deepEqual(parseStates(42), [])
})

test('sends the PAT as Basic with an empty user name', () => {
  assert.equal(authorization('abc'), `Basic ${btoa(':abc')}`)
})

test('builds the WIQL query', () => {
  assert.equal(
    buildWiql(null, ['Closed', "Won't fix"]),
    "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Won''t fix') ORDER BY [System.ChangedDate] DESC"
  )
  assert.equal(
    buildWiql(['P', "O'Neil & Co"], []),
    "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.TeamProject] IN ('P', 'O''Neil & Co') ORDER BY [System.ChangedDate] DESC"
  )
})

const TYPES = '/My%20Project/_apis/wit/workitemtypes'
const metadata = () =>
  workItemTypes(
    ['Task', 'icon_clipboard', [['Active', 'InProgress'], ['Done', 'Completed']]],
    ['Bug', 'icon_insect', [['New', 'Proposed'], ['Weird', 'Whatever']]]
  )

test('lists assigned items in the query order, with icons and categories', async () => {
  const fetch = routedFetch(
    ['/_apis/wit/wiql', wiql(3, 1, 2)],
    [
      '/_apis/wit/workitemsbatch',
      batch(
        { id: 1, title: 'One', column: 'Doing', columnDone: true },
        { id: 2, title: 'Two', type: 'Bug', state: 'New' },
        { id: 3, title: 'Three', type: 'Bug', state: 'Weird' }
      )
    ],
    [TYPES, metadata()]
  )
  const result = await listAssigned(conn(), fetch, { now: () => 1000 })
  const item = (id: number, title: string, over: object) => ({
    id,
    title,
    type: 'Task',
    typeIcon: 'icon_clipboard',
    state: 'Active',
    stateCategory: 'InProgress',
    boardColumn: '',
    boardColumnDone: false,
    states: ['Active', 'Done'],
    project: 'My Project',
    url: `https://dev.azure.com/contoso/My%20Project/_workitems/edit/${id}`,
    childrenTotal: 0,
    childrenDone: 0,
    pullRequests: 0,
    ...over
  })
  assert.deepEqual(result, {
    ok: true,
    fetchedAt: 1000,
    items: [
      item(3, 'Three', { type: 'Bug', typeIcon: 'icon_insect', state: 'Weird', stateCategory: '', states: ['New', 'Weird'] }),
      item(1, 'One', { boardColumn: 'Doing', boardColumnDone: true }),
      item(2, 'Two', { type: 'Bug', typeIcon: 'icon_insect', state: 'New', stateCategory: 'Proposed', states: ['New', 'Weird'] })
    ]
  })

  const q = fetch.calls.find((c) => c.url.includes('/wiql'))!
  const b = fetch.calls.find((c) => c.url.includes('/workitemsbatch') && !(c.body as { $expand?: string }).$expand)!
  const t = fetch.calls.find((c) => c.url.includes('/workitemtypes'))!
  assert.equal(q.method, 'POST')
  assert.equal(q.url, 'https://dev.azure.com/contoso/_apis/wit/wiql?$top=200&api-version=7.1')
  assert.equal(q.headers.Authorization, `Basic ${btoa(`:${FAKE_PAT}`)}`)
  assert.equal(q.headers['X-TFS-FedAuthRedirect'], 'Suppress')
  assert.match((q.body as { query: string }).query, /\[System\.AssignedTo\] = @Me/)
  assert.ok(!(q.body as { query: string }).query.includes('TeamProject'))
  assert.equal(b.url, 'https://dev.azure.com/contoso/_apis/wit/workitemsbatch?api-version=7.1')
  assert.deepEqual((b.body as { ids: number[] }).ids, [3, 1, 2])
  assert.equal((b.body as { errorPolicy: string }).errorPolicy, 'omit')
  const fields = (b.body as { fields: string[] }).fields
  assert.ok(fields.includes('System.AreaPath') && fields.includes('System.BoardColumn'))
  assert.equal(t.method, 'GET')
  assert.equal(t.url, 'https://dev.azure.com/contoso/My%20Project/_apis/wit/workitemtypes?api-version=7.1')
  assert.equal(t.headers.Authorization, `Basic ${btoa(`:${FAKE_PAT}`)}`)
  assert.equal(t.headers['X-TFS-FedAuthRedirect'], 'Suppress')
  assert.equal(t.headers['Content-Type'], undefined)
  assert.equal(t.body, undefined)
})

test('filters by the chosen projects, escaping their names, at the organization level', async () => {
  const fetch = fakeFetch(wiql())
  const result = await listAssigned(conn({ allProjects: false, projects: ['Web', "O'Neil"] }), fetch)
  assert.equal(result.ok && result.items.length, 0)
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0]!.url, 'https://dev.azure.com/contoso/_apis/wit/wiql?$top=200&api-version=7.1')
  assert.match(
    (fetch.calls[0]!.body as { query: string }).query,
    /\[System\.TeamProject\] IN \('Web', 'O''Neil'\)/
  )
})

test('an empty selection answers an empty list without any request', async () => {
  const fetch = fakeFetch()
  const result = await listAssigned(conn({ allProjects: false, projects: [] }), fetch, { now: () => 5 })
  assert.deepEqual(result, { ok: true, items: [], fetchedAt: 5 })
  assert.equal(fetch.calls.length, 0)
})

test('asks for the types of each distinct project, in parallel', async () => {
  const fetch = routedFetch(
    ['/_apis/wit/wiql', wiql(1, 2, 3)],
    [
      '/_apis/wit/workitemsbatch',
      batch(
        { id: 1, title: 'A', project: 'Alpha' },
        { id: 2, title: 'B', project: 'Beta' },
        { id: 3, title: 'C', project: 'Alpha' }
      )
    ],
    ['/Alpha/_apis/wit/workitemtypes', workItemTypes(['Task', 'icon_a', [['Active', 'InProgress']]])],
    ['/Beta/_apis/wit/workitemtypes', workItemTypes(['Task', 'icon_b', [['Active', 'Resolved']]])]
  )
  const result = await listAssigned(conn(), fetch)
  assert.ok(result.ok)
  assert.deepEqual(
    result.items.map((i) => [i.project, i.typeIcon, i.stateCategory]),
    [
      ['Alpha', 'icon_a', 'InProgress'],
      ['Beta', 'icon_b', 'Resolved'],
      ['Alpha', 'icon_a', 'InProgress']
    ]
  )
  assert.equal(fetch.calls.filter((c) => c.url.includes('workitemtypes')).length, 2)
})

test('a failing metadata call degrades the project instead of failing the list', async () => {
  const warnings: string[] = []
  const fetch = routedFetch(
    ['/_apis/wit/wiql', wiql(1, 2)],
    [
      '/_apis/wit/workitemsbatch',
      batch({ id: 1, title: 'A', project: 'Alpha' }, { id: 2, title: 'B', project: 'Beta' })
    ],
    ['/Alpha/_apis/wit/workitemtypes', json({ message: `nope ${FAKE_PAT}` }, 403)],
    ['/Beta/_apis/wit/workitemtypes', workItemTypes(['Task', 'icon_b', [['Active', 'InProgress']]])]
  )
  const result = await listAssigned(conn(), fetch, { warn: (m) => warnings.push(m) })
  assert.ok(result.ok)
  assert.deepEqual(
    result.items.map((i) => [i.project, i.typeIcon, i.stateCategory]),
    [
      ['Alpha', '', ''],
      ['Beta', 'icon_b', 'InProgress']
    ]
  )
  assert.equal(warnings.length, 1)
  assert.ok(!warnings.join().includes(FAKE_PAT))
})

test('a network error or a malformed answer in the metadata call degrades too', async () => {
  for (const answer of [netError('ENOTFOUND'), json({ nothing: true })]) {
    const fetch = routedFetch(
      ['/_apis/wit/wiql', wiql(1)],
      ['/_apis/wit/workitemsbatch', batch({ id: 1, title: 'A' })],
      [TYPES, answer]
    )
    const result = await listAssigned(conn(), fetch)
    assert.ok(result.ok)
    assert.deepEqual([result.items[0]!.typeIcon, result.items[0]!.stateCategory], ['', ''])
    assert.deepEqual(result.items[0]!.states, [])
  }
})

test('caches the types per organization and project for an hour', async () => {
  const cache = createMetadataCache()
  const make = () =>
    routedFetch(
      ['/_apis/wit/wiql', wiql(1)],
      ['/_apis/wit/workitemsbatch', batch({ id: 1, title: 'A' })],
      [TYPES, metadata()]
    )
  let now = 1_000
  const first = make()
  await listAssigned(conn(), first, { cache, now: () => now })
  assert.equal(first.calls.filter((c) => c.url.includes('workitemtypes')).length, 1)

  const second = make()
  now += 59 * 60 * 1000
  const again = await listAssigned(conn({ organization: 'CONTOSO' }), second, { cache, now: () => now })
  assert.equal(second.calls.filter((c) => c.url.includes('workitemtypes')).length, 0)
  assert.ok(again.ok && again.items[0]!.typeIcon === 'icon_clipboard')

  // Another organization has its own entry; an hour later the entry has expired.
  const other = make()
  await listAssigned(conn({ organization: 'fabrikam' }), other, { cache, now: () => now })
  assert.equal(other.calls.filter((c) => c.url.includes('workitemtypes')).length, 1)
  const late = make()
  now += 2 * 60 * 60 * 1000
  await listAssigned(conn(), late, { cache, now: () => now })
  assert.equal(late.calls.filter((c) => c.url.includes('workitemtypes')).length, 1)
})

test('strips the area prefix from titles only when the setting is on', async () => {
  const make = () =>
    routedFetch(
      ['/_apis/wit/wiql', wiql(1)],
      [
        '/_apis/wit/workitemsbatch',
        batch({ id: 1, title: '[Operações Web] - Ajustar login', area: 'Portal\\Operacoes Web' })
      ],
      [TYPES, metadata()]
    )
  const on = await listAssigned(conn(), make())
  assert.equal(on.ok && on.items[0]!.title, 'Ajustar login')
  const off = await listAssigned(conn({ stripAreaPrefix: false }), make())
  assert.equal(off.ok && off.items[0]!.title, '[Operações Web] - Ajustar login')
})

const area = 'Portal\\Operacoes Web\\Time Azul'
const titleCases: [string, string, string, string][] = [
  ['accents and case', '[OPERAÇÕES web] - Ajustar login', area, 'Ajustar login'],
  ['any segment', '[Portal] Ajustar login', area, 'Ajustar login'],
  ['the last segment', '[time azul]: Ajustar login', area, 'Ajustar login'],
  ['spaces inside the bracket', '[  Operacoes   Web ]   Ajustar', area, 'Ajustar'],
  ['en dash', '[Portal] \u2013 Ajustar', area, 'Ajustar'],
  ['em dash', '[Portal]\u2014Ajustar', area, 'Ajustar'],
  ['pipe', '[Portal] | Ajustar', area, 'Ajustar'],
  ['no separator', '[Portal] Ajustar', area, 'Ajustar'],
  ['repeated prefixes', '[Portal] - [Time Azul] - Ajustar', area, 'Ajustar'],
  ['stops at a bracket that does not match', '[Portal] [BUG] Ajustar', area, '[BUG] Ajustar'],
  ['keeps a bracket that does not match', '[BUG] Ajustar login', area, '[BUG] Ajustar login'],
  ['keeps a bracket after the text', 'Ajustar [Portal]', area, 'Ajustar [Portal]'],
  ['keeps a partial match', '[Portal X] Ajustar', area, '[Portal X] Ajustar'],
  ['keeps the title when nothing would be left', '[Portal]', area, '[Portal]'],
  ['keeps the title when only separators would be left', '[Portal] - ', area, '[Portal] - '],
  ['keeps everything when all prefixes would empty it', '[Portal] [Time Azul]', area, '[Portal] [Time Azul]'],
  ['an empty area path', '[Portal] Ajustar', '', '[Portal] Ajustar'],
  ['a plain title', 'Ajustar login', area, 'Ajustar login'],
  ['an empty bracket', '[] Ajustar', area, '[] Ajustar'],
  ['a compound bracket keeps what follows the area', '[Operacoes Web | 1234 | Serviço] Correção', area, '[1234 | Serviço] Correção'],
  ['a compound bracket drops every leading area part', '[Portal | Time Azul | 77] Ajustar', area, '[77] Ajustar'],
  ['a compound bracket made only of area parts goes away', '[Portal | Time Azul] - Ajustar', area, 'Ajustar'],
  ['a compound bracket that starts elsewhere stays', '[1234 | Portal] Ajustar', area, '[1234 | Portal] Ajustar'],
  ['a compound bracket keeps the bracket after it', '[Portal | 12] [BUG] Ajustar', area, '[12] [BUG] Ajustar']
]
for (const [name, title, areaPath, expected] of titleCases) {
  test(`cleanTitle: ${name}`, () => assert.equal(cleanTitle(title, areaPath), expected))
}

test('lists the projects that are well formed, sorted, following the continuation token', async () => {
  const fetch = routedFetch(
    [
      '/_apis/projects',
      [
        projectsAnswer(
          [
            { id: 'id-z', name: 'zeta' },
            { id: 'id-d', name: 'Deleting', state: 'deleting' },
            { id: 'id-a', name: 'Alpha', state: 'WellFormed' }
          ],
          'tok/1'
        ),
        projectsAnswer([{ id: 'id-b', name: 'beta' }, { id: 'id-n', name: 'New' }])
      ]
    ]
  )
  const result = await listProjects(conn(), fetch)
  assert.deepEqual(result, {
    ok: true,
    complete: true,
    projects: [
      { id: 'id-a', name: 'Alpha' },
      { id: 'id-b', name: 'beta' },
      { id: 'id-n', name: 'New' },
      { id: 'id-z', name: 'zeta' }
    ]
  })
  assert.equal(fetch.calls.length, 2)
  assert.equal(fetch.calls[0]!.method, 'GET')
  assert.equal(fetch.calls[0]!.url, 'https://dev.azure.com/contoso/_apis/projects?api-version=7.1&$top=500')
  assert.equal(fetch.calls[1]!.url, `${fetch.calls[0]!.url}&continuationToken=tok%2F1`)
  assert.equal(fetch.calls[0]!.headers['X-TFS-FedAuthRedirect'], 'Suppress')
  assert.equal(fetch.calls[0]!.headers['Content-Type'], undefined)
})

test('stops following the continuation token after five pages', async () => {
  const fetch = routedFetch(['/_apis/projects', projectsAnswer([{ id: 'a', name: 'A' }], 'more')])
  const result = await listProjects(conn(), fetch)
  assert.ok(result.ok)
  assert.equal(fetch.calls.length, 5)
})

for (const status of [401, 403]) {
  test(`projects fall back to the assigned items on ${status}`, async () => {
    const fetch = routedFetch(
      ['/_apis/projects', json({ message: 'no scope' }, status)],
      ['/_apis/wit/wiql', wiql(1, 2, 3)],
      [
        '/_apis/wit/workitemsbatch',
        batch(
          { id: 1, title: 'a', project: 'Web' },
          { id: 2, title: 'b', project: 'Api' },
          { id: 3, title: 'c', project: 'Web' }
        )
      ]
    )
    const result = await listProjects(conn(), fetch)
    assert.deepEqual(result, {
      ok: true,
      complete: false,
      projects: [
        { id: 'Api', name: 'Api' },
        { id: 'Web', name: 'Web' }
      ]
    })
    const q = fetch.calls.find((c) => c.url.includes('/wiql'))!
    assert.ok(!(q.body as { query: string }).query.includes('TeamProject'))
    assert.match((q.body as { query: string }).query, /NOT IN \('Closed', 'Done', 'Removed'\)/)
    const b = fetch.calls.find((c) => c.url.includes('/workitemsbatch'))!
    assert.ok((b.body as { fields: string[] }).fields.includes('System.TeamProject'))
  })
}

test('the fallback reports its own error', async () => {
  const fetch = routedFetch(['/_apis/projects', html(401)], ['/_apis/wit/wiql', html(401)])
  const result = await listProjects(conn(), fetch)
  assert.equal(!result.ok && result.error.kind, 'auth')
})

test('projects: other errors do not fall back', async () => {
  const fetch = routedFetch(['/_apis/projects', json({ message: 'boom' }, 500)])
  const result = await listProjects(conn(), fetch)
  assert.equal(!result.ok && result.error.kind, 'server')
  assert.equal(fetch.calls.length, 1)
})

const cases: [string, Response | Error, string][] = [
  ['401', html(401), 'auth'],
  ['302 to sign-in', html(302, 'https://login.microsoftonline.com/x'), 'auth'],
  ['203 with HTML', html(203), 'auth'],
  ['200 with HTML', html(200), 'auth'],
  ['403', json({ message: 'TF400813: not authorized' }, 403), 'scope'],
  ['404', json({ message: 'TF200016: project does not exist' }, 404), 'notFound'],
  ['500', json({ message: 'boom' }, 500), 'server'],
  ['400 bad query', json({ message: 'TF51005: field does not exist' }, 400), 'server'],
  ['proxy CA', netError('SELF_SIGNED_CERT_IN_CHAIN'), 'tls'],
  ['leaf not verified', netError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls'],
  ['DNS', netError('ENOTFOUND'), 'network'],
  ['timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'network']
]

for (const [name, answer, kind] of cases) {
  test(`classifies ${name} as ${kind}`, async () => {
    const result = await listAssigned(conn(), fakeFetch(answer))
    assert.equal(!result.ok && result.error.kind, kind)
  })
}

test('an error in the batch call is reported too', async () => {
  const result = await listAssigned(conn(), fakeFetch(wiql(1), html(401)))
  assert.equal(!result.ok && result.error.kind, 'auth')
})

test('never puts the PAT in an error detail', async () => {
  const result = await listAssigned(conn(), fakeFetch(json({ message: `bad token ${FAKE_PAT}` }, 500)))
  assert.ok(!result.ok)
  assert.ok(!JSON.stringify(result).includes(FAKE_PAT))
})

const TASK_TYPES = workItemTypes(
  ['Task', 'icon_clipboard', [['Active', 'InProgress'], ['Closed', 'Completed'], ['Removed', 'Removed']]]
)

test('children and pull requests are counted from the relations, degrading to 0 on failure', async () => {
  const routes = (links: Parameters<typeof routedFetch>[0]) => [
    ['/_apis/wit/wiql', wiql(1, 2)],
    [isFieldsBatch, batch({ id: 1, title: 'One' }, { id: 2, title: 'Two' })],
    links,
    [TYPES, TASK_TYPES]
  ] as Parameters<typeof routedFetch>
  const relations = relationsAnswer(
    [1, [child(10), child(11), child(12), child(13), child(14), pr(1), pr(1), pr(2), ['ArtifactLink', 'vstfs:///Git/Commit/x', 'Fixed in Commit'], ['System.LinkTypes.Hierarchy-Reverse', 'https://x/_apis/wit/workItems/99']]],
    [2, []]
  )
  // 10 Completed, 11 Removed (left out), 12 unknown state (counts, not done), 13 open, 14 omitted by the server.
  const kids = batch(
    { id: 10, title: '', state: 'Closed' },
    { id: 11, title: '', state: 'Removed' },
    { id: 12, title: '', state: 'Weird' },
    { id: 13, title: '', state: 'Active' }
  )
  const fetch = routedFetch(
    [(c) => isFieldsBatch(c) && (c.body as { ids: number[] }).ids.includes(10), kids],
    ...routes([isRelationsBatch, relations])
  )
  const result = await listAssigned(conn(), fetch)
  assert.ok(result.ok)
  assert.deepEqual(result.items.map((i) => [i.id, i.childrenTotal, i.childrenDone, i.pullRequests]), [[1, 3, 1, 2], [2, 0, 0, 0]])
  const relCall = fetch.calls.find((c) => isRelationsBatch(c))!
  assert.deepEqual(relCall.body, { ids: [1, 2], $expand: 'relations', errorPolicy: 'omit' })
  const childCall = fetch.calls.find((c) => (c.body as { ids?: number[] })?.ids?.includes(10) && !isRelationsBatch(c))!
  assert.deepEqual((childCall.body as { fields: string[] }).fields, ['System.State', 'System.WorkItemType', 'System.TeamProject'])

  for (const failing of [json({ message: `no ${FAKE_PAT}` }, 500), netError('ECONNRESET')]) {
    const warnings: string[] = []
    const failed = await listAssigned(conn(), routedFetch(...routes([isRelationsBatch, failing])), { warn: (m) => warnings.push(m) })
    assert.ok(failed.ok)
    assert.deepEqual(failed.items.map((i) => [i.childrenTotal, i.childrenDone, i.pullRequests]), [[0, 0, 0], [0, 0, 0]])
    assert.equal(warnings.filter((w) => w.startsWith('relations')).length, 1)
    assert.ok(!warnings.join().includes(FAKE_PAT))
  }
  // The children batch failing degrades the same way.
  const noKids = routedFetch(
    [(c) => isFieldsBatch(c) && (c.body as { ids: number[] }).ids.includes(10), json({}, 500)],
    ...routes([isRelationsBatch, relations])
  )
  const degraded = await listAssigned(conn(), noKids)
  assert.ok(degraded.ok && degraded.items.every((i) => i.childrenTotal === 0 && i.pullRequests === 0))
})

test('relations and children are asked in chunks of 200', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => i + 1)
  const fetch = routedFetch(
    ['/_apis/wit/wiql', wiql(...ids)],
    [isFieldsBatch, batch({ id: 1, title: 'One' })],
    [isRelationsBatch, relationsAnswer([1, [child(500)]])],
    [TYPES, TASK_TYPES]
  )
  assert.ok((await listAssigned(conn(), fetch)).ok)
  const { fetchLinks } = await import('./azure')
  const many = Array.from({ length: 450 }, (_, i) => i + 1)
  const chunked = routedFetch([isRelationsBatch, relationsAnswer()])
  await fetchLinks(conn(), many, chunked, {})
  assert.deepEqual(chunked.calls.map((c) => (c.body as { ids: number[] }).ids.length), [200, 200, 50])
})

test('states of an item are those of its type, in the type order; [] when the type is unknown', () => {
  const meta = new Map([
    ['Bug', { icon: 'icon_insect', states: new Map([['New', 'Proposed'], ['Active', 'InProgress'], ['Closed', 'Completed']] as [string, 'Proposed' | 'InProgress' | 'Completed'][]) }]
  ])
  const raw = (type: string) => ({ id: 1, fields: { 'System.Title': 'T', 'System.WorkItemType': type, 'System.State': 'New', 'System.TeamProject': 'Web' } })
  assert.deepEqual(toItem(raw('Bug'), conn(), meta)!.states, ['New', 'Active', 'Closed'])
  assert.deepEqual(toItem(raw('Epic'), conn(), meta)!.states, [])
  assert.deepEqual(toItem(raw('Bug'), conn(), null)!.states, [])
  assert.deepEqual(toItem(raw('Bug'), conn(), undefined)!.states, [])
})

test('request PATCH sends a json-patch body with the same auth headers', async () => {
  const ops = [{ op: 'add', path: '/fields/System.State', value: 'Active' }]
  const fetch = fakeFetch(json({ id: 7 }))
  const out = await request(fetch, 'PATCH', 'https://dev.azure.com/contoso/_apis/wit/workitems/7?api-version=7.1', ops, FAKE_PAT)
  assert.ok(out.ok)
  const call = fetch.calls[0]!
  assert.equal(call.method, 'PATCH')
  assert.deepEqual(call.body, ops)
  assert.equal(call.headers['Content-Type'], 'application/json-patch+json')
  assert.equal(call.headers.Authorization, `Basic ${btoa(`:${FAKE_PAT}`)}`)
  assert.equal(call.headers['X-TFS-FedAuthRedirect'], 'Suppress')
})

test('request never exposes the HTTP status in its failure', async () => {
  const out = await request(fakeFetch(json({ message: 'no' }, 400)), 'PATCH', 'https://x', [], FAKE_PAT)
  assert.deepEqual(out, { ok: false, error: { kind: 'server', detail: 'HTTP 400: no' } })
})
