// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses. The mock
// host's `requests` stand in for src/worker.ts.
import { assert, mockHost, mount, test, type MockHost, type TestPanel } from 'orca/testing'
import type {
  BoardColumn,
  BoardItem,
  BoardRef,
  BoardResult,
  ConfigView,
  ListResult,
  Prefs,
  Project,
  OpenAgent,
  ProjectsResult,
  StartOptionsResult,
  StateCategory,
  WorkItem
} from './protocol'
import * as panel from './panel'

const URL_ = 'https://dev.azure.com/contoso'
const PAT = 'test-pat-0123456789abcdefghijklmnopqrstuvwxyz'

const item = (
  id: number,
  title: string,
  over: Partial<WorkItem> = {}
): WorkItem => ({
  id,
  title,
  type: 'Bug',
  typeIcon: 'icon_insect',
  state: 'Active',
  stateCategory: 'InProgress',
  boardColumn: '',
  boardColumnDone: false,
  childrenTotal: 0,
  childrenDone: 0,
  pullRequests: 0,
  states: ['New', 'Active', 'Closed'],
  project: 'Web',
  url: `${URL_}/Web/_workitems/edit/${id}`,
  ...over
})

const configured: ConfigView = {
  organization: 'contoso',
  hasPat: true,
  protection: 'os-keyring',
  allProjects: true,
  projects: [],
  groupBy: 'none',
  stripAreaPrefix: true,
  hiddenStates: ['Closed', 'Done', 'Removed'],
  refreshMinutes: 5,
  board: null
}
const blank: ConfigView = { ...configured, organization: '', hasPat: false }
const listed = (...items: WorkItem[]): ListResult => ({ ok: true, items, fetchedAt: Date.now() })

/** A worker stand-in that applies prefs.set to a mutable config, as the real one does. */
function worker(initial: ConfigView, items: ListResult, extra: Record<string, unknown> = {}) {
  const state = { config: initial, prefs: [] as Prefs[], listCalls: 0 }
  const requests = {
    'config.get': () => state.config,
    'items.list': () => {
      state.listCalls++
      return items
    },
    'prefs.set': (input: Prefs) => {
      state.prefs.push(input)
      state.config = { ...state.config, ...input }
      return state.config
    },
    'boards.list': {
      ok: true as const,
      boards: [
        { id: 'b-stories', name: 'Stories' },
        { id: 'b-epics', name: 'Epics' },
        { id: 'b-features', name: 'Features' }
      ]
    },
    ...extra
  }
  return { state, requests }
}

const states = (...names: [string, StateCategory][]) =>
  names.map(([state, stateCategory], index) => item(index + 1, `Item ${index + 1}`, { state, stateCategory }))

const titles = (view: TestPanel, type: string) => view.findAll({ type }).map((e) => e.props.title)

function clean(view: TestPanel, host?: MockHost) {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  if (host) assert.deepEqual(host.refusals, [])
}

test('first run: connects and shows the list', async () => {
  let config = blank
  const saved: unknown[] = []
  const host = mockHost({
    requests: {
      'config.get': () => config,
      'config.save': (input) => {
        saved.push(input)
        config = { ...configured, organization: input.organization }
        return listed(item(42, 'Fix login'))
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Connect to Azure Boards' }))
  // Not connected: no Done button, no projects section, no forget button.
  assert.equal(view.find({ text: 'Done' }), null)
  assert.equal(view.find({ text: 'Projects' }), null)
  assert.equal(view.find({ label: 'Forget PAT' }), null)

  await view.type({ label: 'Organization' }, 'contoso')
  await view.type({ label: 'Personal access token' }, PAT)
  await view.press({ text: 'Connect' })

  assert.deepEqual(saved, [{ organization: 'contoso', pat: PAT }])
  assert.ok(view.find({ label: '#42 Fix login' }))
  // The typed PAT is never persisted.
  assert.ok(!JSON.stringify(view.persisted).includes(PAT))
  clean(view, host)
  await view.unmount()
})

test('the trash button forgets the PAT and is absent without one', async () => {
  const w = worker(configured, listed())
  const cleared: unknown[] = []
  const host = mockHost({
    requests: { ...w.requests, 'pat.clear': () => (cleared.push(1), (w.state.config = { ...configured, hasPat: false })) }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings' })
  // Connected: the connection is a folded section that names the organization.
  const section = view.find({ type: 'Collapsible', text: /Connection/ })
  assert.ok(section)
  assert.equal(section.props.description, 'contoso · PAT stored')
  assert.equal(view.find({ label: 'Forget PAT' }), null)
  await openSection(view, 'Connection')

  const forget = view.find({ label: 'Forget PAT' })
  assert.ok(forget)
  assert.equal(forget.props.icon, 'delete')
  assert.equal(forget.props.tone, 'danger')
  assert.equal(view.find({ type: 'Button', text: 'Forget PAT' }), null)
  // No PAT field while one is stored: the PAT is not part of Save.
  assert.equal(view.find({ type: 'Input', label: 'Personal access token' }), null)

  await view.press({ label: 'Forget PAT' })
  assert.equal(cleared.length, 1)
  assert.equal(view.find({ label: 'Forget PAT' }), null)
  assert.ok(view.find({ text: 'Connect to Azure Boards' }))
  assert.ok(view.find({ type: 'Input', label: 'Personal access token' }))
  clean(view, host)
  await view.unmount()
})

test('lists items; pressing one expands it and Open in browser opens it', async () => {
  const host = mockHost({
    requests: worker(configured, listed(item(1, 'One'), item(2, 'Two'))).requests
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Assigned to me · 2' }))
  assert.ok(view.find({ label: '#2 Two' }))

  await view.press({ label: '#2 Two' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [])
  await view.press({ label: 'Open in browser' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: `${URL_}/Web/_workitems/edit/2` }])
  clean(view, host)
  await view.unmount()
})

test('list items carry the type icon and a short description', async () => {
  const host = mockHost({
    requests: worker(
      configured,
      listed(
        item(1, 'A bug', { boardColumn: 'Doing' }),
        item(2, 'A story', { type: 'User Story', typeIcon: 'icon_book', project: 'Reports' }),
        item(3, 'Custom', { type: 'Widget', typeIcon: '' })
      )
    ).requests
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: '#1 A bug' })?.props.icon, 'bug')
  assert.equal(view.find({ label: '#2 A story' })?.props.icon, 'book')
  assert.equal(view.find({ label: '#3 Custom' })?.props.icon, 'blocks')
  // More than one project in the list: the project shows. Board column shows when not grouped.
  assert.equal(view.find({ label: '#1 A bug' })?.props.description, 'Bug · Active · Doing · Web')
  assert.equal(view.find({ label: '#2 A story' })?.props.description, 'User Story · Active · Reports')
  clean(view, host)
  await view.unmount()
})

test('groups by state in category order and regroups when Group by changes', async () => {
  const w = worker(
    { ...configured, groupBy: 'state' },
    listed(...states(['Closed', 'Completed'], ['Active', 'InProgress'], ['New', 'Proposed'], ['Active', 'InProgress']))
  )
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  // The count sits on the group's own line.
  assert.deepEqual(titles(view, 'Collapsible'), ['New · 1', 'Active · 2', 'Closed · 1'])
  // Grouped by state: the state is not repeated in the description.
  assert.equal(view.find({ label: '#2 Item 2' })?.props.description, 'Bug')

  await view.select({ label: 'Group by' }, 'none')
  assert.deepEqual(w.state.prefs, [{ groupBy: 'none' }])
  assert.equal(w.state.listCalls, 1)
  assert.deepEqual(titles(view, 'Collapsible'), [])
  assert.equal(view.find({ label: '#2 Item 2' })?.props.description, 'Bug · Active')

  await view.select({ label: 'Group by' }, 'state')
  assert.deepEqual(w.state.prefs, [{ groupBy: 'none' }, { groupBy: 'state' }])
  assert.deepEqual(titles(view, 'Collapsible'), ['New · 1', 'Active · 2', 'Closed · 1'])
  clean(view, host)
  await view.unmount()
})

test('a collapsed group stays collapsed across runs', async () => {
  const w = worker({ ...configured, groupBy: 'state' }, listed(...states(['New', 'Proposed'], ['Active', 'InProgress'])))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: '#2 Item 2' }))
  await view.toggle({ type: 'Collapsible', text: /Active/ })
  assert.equal(view.find({ label: '#2 Item 2' }), null)
  assert.ok(view.find({ label: '#1 Item 1' }))
  assert.ok(JSON.stringify(view.persisted.plugin).includes('state:Active'))
  clean(view, host)
  await view.unmount()

  const again = await mount(panel, { host, persisted: { plugin: view.persisted.plugin } })
  assert.equal(again.find({ label: '#2 Item 2' }), null)
  assert.ok(again.find({ label: '#1 Item 1' }))
  clean(again, host)
  await again.unmount()
})

test('groups by board column with "No column" last', async () => {
  const w = worker(
    { ...configured, groupBy: 'boardColumn' },
    listed(
      item(1, 'A', { boardColumn: '', state: 'New', stateCategory: 'Proposed' }),
      item(2, 'B', { boardColumn: 'Done', state: 'Closed', stateCategory: 'Completed' }),
      item(3, 'C', { boardColumn: 'Doing', state: 'Active', stateCategory: 'InProgress' })
    )
  )
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  assert.deepEqual(titles(view, 'Collapsible'), ['Doing · 1', 'Done · 1', 'No column · 1'])
  assert.equal(view.find({ label: '#3 C' })?.props.description, 'Bug · Active')
  clean(view, host)
  await view.unmount()
})

test('empty list', async () => {
  const host = mockHost({ requests: worker(configured, listed()).requests })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'Nothing assigned' }))
  await view.unmount()
})

test('a refused PAT shows a clear error and leads to settings', async () => {
  const host = mockHost({
    requests: worker(configured, { ok: false, error: { kind: 'auth', detail: 'HTTP 401' } }).requests
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'PAT refused' }))
  assert.ok(view.find({ text: 'HTTP 401' }))

  await view.press({ text: 'Settings' })
  assert.ok(view.find({ text: 'Settings' }))
  await openSection(view, 'Connection')
  assert.ok(view.find({ label: 'Forget PAT' }))
  await view.unmount()
})

test('a failed connect stays on the form with the reason', async () => {
  const host = mockHost({
    requests: {
      'config.get': blank,
      'config.save': { ok: false, error: { kind: 'notFound', detail: 'TF200016' } }
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'Organization' }, 'contoso')
  await view.type({ label: 'Personal access token' }, PAT)
  await view.press({ text: 'Connect' })
  assert.ok(view.find({ text: 'Connect to Azure Boards' }))
  assert.ok(view.find({ label: 'Not found' }))
  await view.unmount()
})

test('warns up front when Orca cannot encrypt secrets', async () => {
  const host = mockHost({ requests: { 'config.get': { ...blank, protection: 'unavailable' } } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'The PAT cannot be stored safely' }))
  await view.unmount()
})

const web: Project = { id: 'p-web', name: 'Web' }
const names9 = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'Operações']
const many: Project[] = names9.map((name) => ({ id: `id-${name}`, name }))

async function openSettings(view: TestPanel) {
  await view.press({ label: 'Settings' })
}

/** Unfolds a config section by its title. */
async function openSection(view: TestPanel, title: string) {
  await view.toggle({ type: 'Collapsible', text: new RegExp(`^${title}`) })
}

test('projects: ticks stay in the draft until Save, which saves them all and shows the list', async () => {
  const reports: Project = { id: 'p-rep', name: 'Reports' }
  let projectCalls = 0
  const w = worker({ ...configured, allProjects: false, projects: [web] }, listed(item(1, 'One')), {
    'projects.list': (): ProjectsResult => (projectCalls++, { ok: true, projects: [web, reports], complete: true })
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  // A chosen subset opens the Projects section.
  assert.equal(projectCalls, 1)
  assert.equal(view.valueOf({ type: 'Checkbox', label: 'Web' }), true)
  assert.equal(view.valueOf({ type: 'Checkbox', label: 'Reports' }), false)
  assert.ok(view.find({ text: '1 selected' }))
  assert.equal(view.find({ text: /Only projects with items/ }), null)
  assert.equal(view.find({ type: 'Input', label: 'Search projects' }), null)

  await view.toggle({ type: 'Checkbox', label: 'Reports' })
  assert.ok(view.find({ text: '2 selected' }))
  await view.toggle({ type: 'Checkbox', label: 'Web' })
  assert.deepEqual(w.state.prefs, [])

  await view.press({ text: 'Save' })
  assert.deepEqual(w.state.prefs, [
    { allProjects: false, projects: [reports], stripAreaPrefix: true, refreshMinutes: 5, board: null }
  ])
  assert.ok(view.find({ label: '#1 One' }))
  assert.equal(w.state.listCalls, 2)
  assert.equal(projectCalls, 1)
  clean(view, host)
  await view.unmount()
})

test('projects: an empty choice warns that the list will be empty', async () => {
  const w = worker({ ...configured, allProjects: false, projects: [web] }, listed(), {
    'projects.list': { ok: true, projects: [web], complete: true }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  await view.toggle({ type: 'Checkbox', label: 'Web' })
  assert.ok(view.find({ text: /list will be empty/ }))
  clean(view, host)
  await view.unmount()
})

test('projects: switching All projects off asks for the list, and Back discards it', async () => {
  let projectCalls = 0
  const w = worker(configured, listed(), {
    'projects.list': (): ProjectsResult => (projectCalls++, { ok: true, projects: [web], complete: true })
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  // Every project: the section starts folded, with that summary.
  assert.equal(view.find({ type: 'Collapsible', text: /Projects/ })?.props.description, 'All projects')
  await openSection(view, 'Projects')
  assert.equal(projectCalls, 0)
  assert.equal(view.find({ type: 'Checkbox', label: 'Web' }), null)

  await view.toggle({ label: 'All projects' })
  assert.equal(projectCalls, 1)
  assert.ok(view.find({ type: 'Checkbox', label: 'Web' }))
  await view.toggle({ label: 'All projects' })
  assert.equal(view.find({ type: 'Checkbox', label: 'Web' }), null)
  await view.toggle({ label: 'All projects' })

  await view.press({ text: 'Back' })
  assert.deepEqual(w.state.prefs, [])
  assert.equal(w.state.listCalls, 2)
  await openSettings(view)
  assert.equal(view.find({ type: 'Collapsible', text: /Projects/ })?.props.description, 'All projects')
  clean(view, host)
  await view.unmount()
})

test('projects: an incomplete list warns about the missing scope; selected ones missing from it stay', async () => {
  const gone: Project = { id: 'p-gone', name: 'Archived' }
  const w = worker({ ...configured, allProjects: false, projects: [gone] }, listed(), {
    'projects.list': { ok: true, projects: [{ id: 'Web', name: 'Web' }], complete: false }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  assert.ok(view.find({ text: /Only projects with items assigned to you/ }))
  assert.equal(view.valueOf({ type: 'Checkbox', label: 'Archived' }), true)

  await view.toggle({ type: 'Checkbox', label: 'Web' })
  await view.toggle({ type: 'Checkbox', label: 'Archived' })
  await view.press({ text: 'Save' })
  assert.deepEqual(w.state.prefs.at(-1)?.projects, [{ id: 'Web', name: 'Web' }])
  clean(view, host)
  await view.unmount()
})

test('projects: a failed list shows the error and retries', async () => {
  let calls = 0
  const w = worker({ ...configured, allProjects: false }, listed(), {
    'projects.list': (): ProjectsResult =>
      ++calls === 1 ? { ok: false, error: { kind: 'network', detail: 'ETIMEDOUT' } } : { ok: true, projects: [web], complete: true }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  assert.ok(view.find({ label: 'No connection' }))
  await view.press({ text: 'Try again' })
  assert.ok(view.find({ type: 'Checkbox', label: 'Web' }))
  assert.equal(calls, 2)
  clean(view, host)
  await view.unmount()
})

test('projects: the search box appears past 8 projects and ignores case and accents', async () => {
  const w = worker({ ...configured, allProjects: false }, listed(), {
    'projects.list': { ok: true, projects: many, complete: true }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  assert.equal(view.findAll({ type: 'Checkbox' }).length, 9)
  await view.type({ type: 'Input', label: 'Search projects' }, 'OPERACOES')
  const boxes = view.findAll({ type: 'Checkbox' })
  assert.deepEqual(boxes.map((b) => b.label), ['Operações'])
  clean(view, host)
  await view.unmount()
})

test('display: the prefix switch and the refresh interval are saved together', async () => {
  const w = worker(configured, listed(item(1, 'One')))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  await openSection(view, 'Display')
  await openSection(view, 'Refresh')
  assert.equal(view.valueOf({ label: 'Remove the area prefix from titles' }), true)
  assert.equal(view.valueOf({ label: 'Refresh every' }), '5')
  await view.toggle({ label: 'Remove the area prefix from titles' })
  await view.select({ label: 'Refresh every' }, '15')
  assert.deepEqual(w.state.prefs, [])

  assert.equal(w.state.listCalls, 1)
  await view.press({ text: 'Save' })
  assert.deepEqual(w.state.prefs, [
    { allProjects: true, projects: [], stripAreaPrefix: false, refreshMinutes: 15, board: null }
  ])
  assert.equal(w.state.listCalls, 2)
  assert.ok(view.find({ label: '#1 One' }))
  clean(view, host)
  await view.unmount()
})

test('a failed Save stays on the screen with the draft and says so', async () => {
  const w = worker(configured, listed(), {
    'prefs.set': () => {
      throw new Error('disk full')
    }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  await openSection(view, 'Display')
  await view.toggle({ label: 'Remove the area prefix from titles' })
  await view.press({ text: 'Save' })
  assert.ok(view.find({ text: 'The settings were not saved.' }))
  assert.equal(view.valueOf({ label: 'Remove the area prefix from titles' }), false)
  assert.equal(w.state.listCalls, 1)
  await view.unmount()
})

test('automatic refresh reloads a stale list only while visible and when on', async () => {
  const w = worker(configured, listed(item(1, 'One')))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  const now = Date.now()
  assert.equal(panel.refreshIfDue(now + 4 * 60_000), false)
  assert.equal(w.state.listCalls, 1)
  assert.equal(panel.refreshIfDue(now + 6 * 60_000), true)
  await view.settled()
  assert.equal(w.state.listCalls, 2)

  await view.setVisible(false)
  assert.equal(panel.refreshIfDue(now + 60 * 60_000), false)
  await view.setVisible(true)
  await view.post('config.changed', { ...configured, refreshMinutes: 0 })
  assert.equal(panel.refreshIfDue(now + 60 * 60_000), false)
  assert.equal(w.state.listCalls, 2)
  clean(view, host)
  await view.unmount()
})

test('reloads when the settings change in Orca', async () => {
  let calls = 0
  const host = mockHost({
    requests: {
      'config.get': configured,
      'items.list': () => listed(...(++calls === 1 ? [] : [item(9, 'Nine')]))
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'Nothing assigned' }))
  await view.post('config.changed', { ...configured, stripAreaPrefix: false })
  assert.ok(view.find({ label: '#9 Nine' }))
  await view.unmount()
})

test('a grouping change from the worker regroups without asking for the items again', async () => {
  const w = worker({ ...configured, groupBy: 'state' }, listed(...states(['New', 'Proposed'])))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  assert.equal(w.state.listCalls, 1)
  // The worker echoes a grouping change (the panel's own, or one made in Orca's Settings).
  await view.post('config.changed', { ...configured, groupBy: 'none' })
  assert.equal(w.state.listCalls, 1)
  assert.deepEqual(titles(view, 'Collapsible'), [])
  // Hidden states change which items exist: that reloads.
  await view.post('config.changed', { ...configured, groupBy: 'none', hiddenStates: ['Closed'] })
  assert.equal(w.state.listCalls, 2)
  clean(view, host)
  await view.unmount()
})

test('speaks Brazilian Portuguese', async () => {
  const blankHost = mockHost({ requests: { 'config.get': blank } })
  const first = await mount(panel, { host: blankHost, locale: 'pt-BR' })
  assert.ok(first.find({ text: 'Conectar ao Azure Boards' }))
  assert.ok(first.find({ text: 'Conectar' }))
  await first.unmount()

  const w = worker({ ...configured, allProjects: false, projects: [web] }, listed(item(1, 'Um')), {
    'projects.list': { ok: true, projects: [web], complete: false }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, locale: 'pt-BR' })
  assert.ok(view.find({ label: 'Agrupar por' }))
  assert.ok(view.find({ text: 'Atribuídos a mim · 1' }))
  await view.press({ label: 'Configurações' })
  await openSection(view, 'Conexão')
  assert.ok(view.find({ label: 'Esquecer PAT' }))
  assert.ok(view.find({ label: 'Todos os projetos' }))
  assert.ok(view.find({ text: '1 selecionado' }))
  assert.ok(view.find({ text: /Só aparecem os projetos/ }))
  assert.equal(view.find({ type: 'Collapsible', text: /^Exibição/ })?.props.description, 'Prefixo da área removido')
  assert.equal(view.find({ type: 'Collapsible', text: /^Atualização/ })?.props.description, '5 minutos')
  await openSection(view, 'Exibição')
  assert.ok(view.find({ label: 'Remover o prefixo da área dos títulos' }))
  assert.ok(view.find({ text: 'Salvar' }))
  assert.ok(view.find({ text: 'Voltar' }))
  clean(view, host)
  await view.unmount()
})

// ---------------------------------------------------------------------------------------------
// Board tab

const boardRef: BoardRef = {
  projectId: 'p-web',
  projectName: 'Web',
  teamId: 't-core',
  teamName: 'Core',
  boardId: 'b-stories',
  boardName: 'Stories'
}
const withBoard: ConfigView = { ...configured, board: boardRef }
const column = (id: string, over: Partial<BoardColumn> = {}): BoardColumn => ({
  id,
  name: id,
  itemLimit: 0,
  isSplit: false,
  columnType: 'inProgress',
  ...over
})
const bItem = (id: number, boardColumn: string, over: Partial<BoardItem> = {}): BoardItem => ({
  ...item(id, `Card ${id}`, { boardColumn }),
  assignedTo: 'Ana',
  mine: false,
  ...over
})
const boardResult = (over: Partial<Extract<BoardResult, { ok: true }>> = {}): BoardResult => ({
  ok: true,
  board: boardRef,
  iteration: { name: 'Sprint 7', path: 'Web\\Sprint 7' },
  columns: [
    column('New', { columnType: 'incoming' }),
    column('Doing', { isSplit: true, itemLimit: 3 }),
    column('Review'),
    column('Closed', { columnType: 'outgoing' })
  ],
  items: [
    bItem(1, 'New', { mine: true }),
    bItem(2, 'Doing', { assignedTo: '' }),
    bItem(3, 'Doing', { boardColumnDone: true }),
    bItem(4, 'Closed'),
    bItem(5, 'Gone')
  ],
  truncated: false,
  fetchedAt: Date.now(),
  ...over
})

async function openBoard(view: TestPanel) {
  await view.select({ type: 'Tabs' }, 'board')
}

test('tabs: the Board tab loads once on first selection and the choice persists', async () => {
  let boardCalls = 0
  const w = worker(withBoard, listed(item(1, 'One'), item(2, 'Two')), {
    'board.get': () => (boardCalls++, boardResult())
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Assigned to me · 2' }))
  assert.equal(view.find({ type: 'Tab', label: 'Board' })?.props.icon, 'blocks')
  assert.equal(view.find({ type: 'Tab', text: /^Assigned to me/ })?.props.icon, 'check')
  assert.equal(boardCalls, 0)
  await openBoard(view)
  assert.equal(boardCalls, 1)
  assert.ok(view.find({ text: 'Core' }))
  assert.ok(view.find({ text: 'Sprint 7' }))
  await view.select({ type: 'Tabs' }, 'assigned')
  await openBoard(view)
  assert.equal(boardCalls, 1)
  assert.equal(w.state.listCalls, 1)
  assert.equal((view.persisted.plugin as Record<string, unknown>).activeTab, 'board')
  clean(view, host)
  await view.unmount()

  // A later run opens on the Board tab and does not load the assigned list.
  const again = await mount(panel, { host, persisted: { plugin: view.persisted.plugin } })
  assert.ok(again.find({ text: 'Core' }))
  assert.equal(w.state.listCalls, 1)
  clean(again, host)
  await again.unmount()
})

test('board: columns in order with counts and WIP limits, halves, folded outgoing column', async () => {
  const w = worker(withBoard, listed(), { 'board.get': boardResult() })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, persisted: { plugin: { activeTab: 'board' } } })
  assert.deepEqual(titles(view, 'Collapsible'), ['New · 1', 'Doing · 2/3', 'Review · 0', 'Closed · 1', 'Other · 1'])
  // Split column: both sub-headings and the right item under each.
  assert.ok(view.find({ text: 'Doing' }))
  assert.ok(view.find({ text: 'Done' }))
  assert.ok(view.find({ label: '#2 Card 2' }))
  assert.ok(view.find({ label: '#3 Card 3' }))
  assert.ok(view.findAll({ type: 'List' }).some((l) => l.props.label === 'Doing · Doing'))
  assert.ok(view.findAll({ type: 'List' }).some((l) => l.props.label === 'Doing · Done'))
  // Empty column: a quiet line. Outgoing column: folded. Stray items: "Other".
  assert.ok(view.find({ text: 'No items' }))
  assert.equal(view.find({ label: '#4 Card 4' }), null)
  assert.ok(view.find({ label: '#5 Card 5' }))
  // Own item highlighted; an unassigned item shows no assignee.
  assert.equal(view.find({ label: '#1 Card 1' })?.props.current, true)
  assert.equal(view.find({ label: '#3 Card 3' })?.props.current, false)
  assert.equal(view.find({ label: '#2 Card 2' })?.props.description, 'Bug')
  assert.equal(view.find({ label: '#1 Card 1' })?.props.description, 'Bug · Ana')
  assert.equal(view.find({ text: 'Showing the first 200 items' }), null)

  await view.toggle({ type: 'Collapsible', text: /^Closed/ })
  assert.ok(view.find({ label: '#4 Card 4' }))
  assert.ok(JSON.stringify(view.persisted.plugin).includes('board:b-stories:Closed'))
  await view.press({ label: '#1 Card 1' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [])
  await view.press({ label: 'Open in browser' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: `${URL_}/Web/_workitems/edit/1` }])
  clean(view, host)
  await view.unmount()
})

test('board: a half without items keeps its heading with a dash, and truncation is said', async () => {
  const result = boardResult({ items: [bItem(2, 'Doing')], truncated: true })
  const host = mockHost({ requests: worker(withBoard, listed(), { 'board.get': result }).requests })
  const view = await mount(panel, { host, persisted: { plugin: { activeTab: 'board' } } })
  assert.ok(view.find({ text: 'Done' }))
  assert.ok(view.find({ text: '—' }))
  assert.ok(view.find({ text: 'Showing the first 200 items' }))
  clean(view, host)
  await view.unmount()
})

test('board: not configured offers to choose one and opens the Board section', async () => {
  const w = worker(configured, listed(), {
    'board.get': { ok: false, error: { kind: 'boardNotConfigured' } },
    'projects.list': { ok: true, projects: [web], complete: true }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openBoard(view)
  assert.ok(view.find({ label: 'Choose a team board' }))
  await view.press({ text: 'Choose board' })
  assert.ok(view.find({ text: 'Settings' }))
  assert.equal(view.find({ type: 'Collapsible', text: /^Board/ })?.props.description, 'Not chosen')
  assert.ok(view.find({ type: 'Select', label: 'Project' }))
  clean(view, host)
  await view.unmount()
})

test('board: no current iteration is an error with Try again', async () => {
  let calls = 0
  const w = worker(withBoard, listed(), {
    'board.get': () => (++calls === 1 ? { ok: false, error: { kind: 'noCurrentIteration' } } : boardResult())
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openBoard(view)
  assert.ok(view.find({ label: 'No current iteration' }))
  await view.press({ text: 'Try again' })
  assert.ok(view.find({ text: 'Core' }))
  assert.equal(calls, 2)
  clean(view, host)
  await view.unmount()
})

const teamsOf = (projectId: string) => ({ ok: true, teams: [{ id: `t-${projectId}`, name: `Team ${projectId}` }] })

test('config: the Board section picks project, team and board; Save sends it', async () => {
  const teamCalls: unknown[] = []
  const boardCalls: unknown[] = []
  const reports: Project = { id: 'p-rep', name: 'Reports' }
  let projectCalls = 0
  const w = worker(configured, listed(), {
    'projects.list': () => (projectCalls++, { ok: true, projects: [web, reports], complete: true }),
    'teams.list': (input: unknown) => (teamCalls.push(input), { ok: true, teams: [{ id: 't-1', name: 'Core' }] }),
    'boards.list': (input: unknown) => (
      boardCalls.push(input),
      { ok: true, boards: [{ id: 'b-2', name: 'Features' }, { id: 'b-1', name: 'Stories' }] }
    )
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  assert.equal(projectCalls, 0)
  await openSection(view, 'Board')
  assert.equal(projectCalls, 1)
  assert.equal(view.find({ type: 'Select', label: 'Team' }), null)

  await view.select({ type: 'Select', label: 'Project' }, 'p-web')
  assert.deepEqual(teamCalls, [{ projectId: 'p-web' }])
  await view.select({ type: 'Select', label: 'Team' }, 't-1')
  assert.deepEqual(boardCalls, [{ projectId: 'p-web', teamId: 't-1' }])
  // No board Select: the team's Stories board is taken.
  assert.equal(view.find({ type: 'Select', label: 'Board' }), null)
  assert.equal(view.find({ type: 'Collapsible', text: /^Board/ })?.props.description, 'Core · Stories')

  // Changing the project clears team and board.
  await view.select({ type: 'Select', label: 'Project' }, 'p-rep')
  assert.equal(view.find({ type: 'Collapsible', text: /^Board/ })?.props.description, 'Not chosen')
  await view.select({ type: 'Select', label: 'Team' }, 't-1')
  assert.deepEqual(w.state.prefs, [])

  await view.press({ text: 'Save' })
  assert.deepEqual(w.state.prefs, [
    {
      allProjects: true,
      projects: [],
      stripAreaPrefix: true,
      refreshMinutes: 5,
      board: {
        projectId: 'p-rep',
        projectName: 'Reports',
        teamId: 't-1',
        teamName: 'Core',
        boardId: 'b-1',
        boardName: 'Stories'
      }
    }
  ])

  await openSettings(view)
  assert.equal(view.find({ type: 'Collapsible', text: /^Board/ })?.props.description, 'Core · Stories')
  clean(view, host)
  await view.unmount()
})

test('config: a teams.list scope error explains the missing PAT scope; Back discards the board', async () => {
  const w = worker(withBoard, listed(), {
    'projects.list': { ok: true, projects: [web], complete: true },
    'teams.list': { ok: false, error: { kind: 'scope' } }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openSettings(view)
  await openSection(view, 'Board')
  assert.ok(view.find({ text: /Project and Team \(Read\)/ }))
  await view.press({ text: 'Back' })
  assert.deepEqual(w.state.prefs, [])
  await openSettings(view)
  assert.equal(view.find({ type: 'Collapsible', text: /^Board/ })?.props.description, 'Core · Stories')
  clean(view, host)
  await view.unmount()
})

test('refresh and automatic refresh act on the active tab', async () => {
  let boardCalls = 0
  const w = worker(withBoard, listed(item(1, 'One')), { 'board.get': () => (boardCalls++, boardResult()) })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await openBoard(view)
  await view.press({ label: 'Refresh' })
  assert.equal(boardCalls, 2)
  assert.equal(w.state.listCalls, 1)
  assert.equal(panel.refreshIfDue(Date.now() + 6 * 60_000), true)
  await view.settled()
  assert.equal(boardCalls, 3)
  assert.equal(w.state.listCalls, 1)
  clean(view, host)
  await view.unmount()
})

test('a board change from the worker reloads the Board tab, and invalidates it when hidden', async () => {
  let boardCalls = 0
  const w = worker(withBoard, listed(item(1, 'One')), { 'board.get': () => (boardCalls++, boardResult()) })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  const other = { ...withBoard, board: { ...boardRef, boardId: 'b-2', boardName: 'Features' } }
  // Hidden: nothing is fetched until the tab is shown.
  await view.post('config.changed', other)
  assert.equal(boardCalls, 0)
  assert.equal(w.state.listCalls, 1)
  await openBoard(view)
  assert.equal(boardCalls, 1)
  // Shown: reloads at once.
  await view.post('config.changed', withBoard)
  assert.equal(boardCalls, 2)
  clean(view, host)
  await view.unmount()
})

test('speaks Brazilian Portuguese on the Board tab and in its settings', async () => {
  const w = worker(configured, listed(), {
    'board.get': { ok: false, error: { kind: 'boardNotConfigured' } },
    'projects.list': { ok: true, projects: [web], complete: true }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, locale: 'pt-BR' })
  await view.select({ type: 'Tabs' }, 'board')
  assert.ok(view.find({ label: 'Escolha o board do time' }))
  await view.press({ text: 'Escolher board' })
  assert.equal(view.find({ type: 'Collapsible', text: /^Board/ })?.props.description, 'Não escolhido')
  assert.ok(view.find({ type: 'Select', label: 'Projeto' }))
  clean(view, host)
  await view.unmount()

  const ok = worker(withBoard, listed(), { 'board.get': boardResult({ truncated: true }) })
  const hostOk = mockHost({ requests: ok.requests })
  const again = await mount(panel, { host: hostOk, locale: 'pt-BR', persisted: { plugin: { activeTab: 'board' } } })
  assert.ok(again.find({ text: 'Mostrando os primeiros 200 itens' }))
  assert.ok(again.find({ text: 'Outros · 1' }) || titles(again, 'Collapsible').includes('Outros · 1'))
  assert.equal(again.find({ label: '#2 Card 2' })?.props.description, 'Bug')
  clean(again, hostOk)
  await again.unmount()
})

test('board header: the level Select lists boards in level order and saves the choice', async () => {
  let boardCalls = 0
  const w = worker(withBoard, listed(), {
    'board.get': () => (boardCalls++, boardResult()),
    'boards.list': {
      ok: true,
      boards: [
        { id: 'b-stories', name: 'Stories' },
        { id: 'b-x', name: 'Zeta' },
        { id: 'b-epics', name: 'Epics' },
        { id: 'b-features', name: 'Features' }
      ]
    }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, persisted: { plugin: { activeTab: 'board' } } })
  const select = view.find({ type: 'Select', label: 'Board level' })
  assert.ok(select)
  assert.deepEqual((select.props.options as { label: string }[]).map((o) => o.label), ['Epics', 'Features', 'Stories', 'Zeta'])
  assert.equal(view.valueOf({ label: 'Board level' }), 'b-stories')
  assert.equal(boardCalls, 1)

  await view.select({ label: 'Board level' }, 'b-features')
  assert.deepEqual(w.state.prefs, [{ board: { ...boardRef, boardId: 'b-features', boardName: 'Features' } }])
  assert.equal(boardCalls, 2)
  clean(view, host)
  await view.unmount()
})

test('speaks Brazilian Portuguese for the board level Select', async () => {
  const w = worker(withBoard, listed(), { 'board.get': boardResult() })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, locale: 'pt-BR', persisted: { plugin: { activeTab: 'board' } } })
  assert.ok(view.find({ type: 'Select', label: 'Nível do board' }))
  clean(view, host)
  await view.unmount()
})

test('counters: tasks and pull requests follow the state and precede the project, only when non-zero', async () => {
  const host = mockHost({
    requests: worker(
      configured,
      listed(
        item(1, 'Both', { childrenTotal: 4, childrenDone: 1, pullRequests: 29, project: 'Web' }),
        item(2, 'One PR', { pullRequests: 1, project: 'Reports' }),
        item(3, 'Done all', { childrenTotal: 2, childrenDone: 2 }),
        item(4, 'None')
      )
    ).requests
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: '#1 Both' })?.props.description, 'Bug · Active · Tasks 1/4 · 29 PRs · Web')
  assert.equal(view.find({ label: '#2 One PR' })?.props.description, 'Bug · Active · 1 PR · Reports')
  assert.equal(view.find({ label: '#3 Done all' })?.props.description, 'Bug · Active · Tasks 2/2 · Web')
  assert.equal(view.find({ label: '#4 None' })?.props.description, 'Bug · Active · Web')
  clean(view, host)
  await view.unmount()
})

test('counters on the board follow the assignee, and speak Portuguese', async () => {
  const result = boardResult({
    items: [bItem(1, 'New', { childrenTotal: 3, childrenDone: 0, pullRequests: 2 }), bItem(2, 'New', { assignedTo: '' })]
  })
  const host = mockHost({ requests: worker(withBoard, listed(), { 'board.get': result }).requests })
  const view = await mount(panel, { host, persisted: { plugin: { activeTab: 'board' } } })
  assert.equal(view.find({ label: '#1 Card 1' })?.props.description, 'Bug · Ana · Tasks 0/3 · 2 PRs')
  assert.equal(view.find({ label: '#2 Card 2' })?.props.description, 'Bug')
  await view.unmount()

  const pt = await mount(panel, { host, locale: 'pt-BR', persisted: { plugin: { activeTab: 'board' } } })
  assert.equal(pt.find({ label: '#1 Card 1' })?.props.description, 'Bug · Ana · Tarefas 0/3 · 2 PRs')
  clean(pt, host)
  await pt.unmount()
})

// ---------------------------------------------------------------------------------------------
// Item actions

test('actions: one item expands at a time, without opening the browser; pressing it again or Close collapses it', async () => {
  const w = worker(configured, listed(item(1, 'One'), item(2, 'Two')))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'Open in browser' }), null)
  await view.press({ label: '#1 One' })
  assert.ok(view.find({ label: 'Open in browser' }))
  assert.ok(view.find({ type: 'Select', label: 'Move to' }))
  // Pressing the open item again folds its actions.
  await view.press({ label: '#1 One' })
  assert.equal(view.find({ label: 'Open in browser' }), null)
  await view.press({ label: '#1 One' })
  assert.ok(view.find({ label: 'Open in browser' }))
  // Another item takes over.
  await view.press({ label: '#2 Two' })
  assert.equal(view.findAll({ label: 'Open in browser' }).length, 1)
  assert.ok(view.find({ label: '#1 One' }))
  await view.press({ label: 'Close' })
  assert.equal(view.find({ label: 'Open in browser' }), null)
  assert.deepEqual(host.callsOf('shell.openExternal'), [])
  clean(view, host)
  await view.unmount()
})

test('actions: Move to a state sends the request, then collapses and reloads', async () => {
  const moves: unknown[] = []
  const w = worker(configured, listed(item(1, 'One')), {
    'item.move': (input: unknown) => (moves.push(input), { ok: true })
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  const select = view.find({ type: 'Select', label: 'Move to' })
  assert.equal(select?.props.value, 'Active')
  assert.deepEqual((select?.props.options as { value: string }[]).map((o) => o.value), ['New', 'Active', 'Closed'])
  await view.select({ type: 'Select', label: 'Move to' }, 'Closed')
  assert.deepEqual(moves, [{ id: 1, target: { kind: 'state', state: 'Closed' } }])
  assert.equal(w.state.listCalls, 2)
  assert.equal(view.find({ label: 'Open in browser' }), null)
  clean(view, host)
  await view.unmount()
})

test('actions: an item without known states offers only its own, disabled', async () => {
  const w = worker(configured, listed(item(1, 'One', { states: [] })))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  const select = view.find({ type: 'Select', label: 'Move to' })
  assert.deepEqual(select?.props.options, [{ value: 'Active', label: 'Active' }])
  assert.equal(select?.props.disabled, true)
  clean(view, host)
  await view.unmount()
})

test('actions: Move to a Done half sends the column and the half, and reloads the board', async () => {
  const moves: unknown[] = []
  let boardCalls = 0
  const w = worker(withBoard, listed(), {
    'board.get': () => (boardCalls++, boardResult()),
    'item.move': (input: unknown) => (moves.push(input), { ok: true })
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, persisted: { plugin: { activeTab: 'board' } } })
  await view.press({ label: '#2 Card 2' })
  const select = view.find({ type: 'Select', label: 'Move to' })
  assert.equal(select?.props.value, 'Doing:doing')
  assert.deepEqual((select?.props.options as { label: string }[]).map((o) => o.label), [
    'New',
    'Doing · Doing',
    'Doing · Done',
    'Review',
    'Closed'
  ])
  await view.select({ type: 'Select', label: 'Move to' }, 'Doing:done')
  assert.deepEqual(moves, [{ id: 2, target: { kind: 'column', columnId: 'Doing', done: true } }])
  assert.equal(boardCalls, 2)
  // A plain column sends done: false.
  await view.press({ label: '#2 Card 2' })
  await view.select({ type: 'Select', label: 'Move to' }, 'Review')
  assert.deepEqual(moves[1], { id: 2, target: { kind: 'column', columnId: 'Review', done: false } })
  clean(view, host)
  await view.unmount()
})

test('actions: a refused move stays expanded and shows the error inline', async () => {
  const w = worker(configured, listed(item(1, 'One')), {
    'item.move': { ok: false, error: { kind: 'writeScope', detail: 'HTTP 403' } }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.select({ type: 'Select', label: 'Move to' }, 'Closed')
  assert.ok(view.find({ label: 'The PAT can’t change work items' }))
  assert.ok(view.find({ text: 'HTTP 403' }))
  assert.ok(view.find({ label: 'Open in browser' }))
  assert.equal(w.state.listCalls, 1)
  // Closing hides the error with the item.
  await view.press({ label: 'Close' })
  assert.equal(view.find({ text: 'HTTP 403' }), null)
  clean(view, host)
  await view.unmount()
})

test('actions: a thrown request is shown as a server error', async () => {
  const w = worker(configured, listed(item(1, 'One')), {
    'item.move': () => {
      throw new Error('boom')
    }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.select({ type: 'Select', label: 'Move to' }, 'New')
  assert.ok(view.find({ label: 'Unexpected answer' }))
  assert.ok(view.find({ text: 'boom' }))
  await view.unmount()
})

test('actions: speaks Brazilian Portuguese, including a rule refusal', async () => {
  const w = worker(configured, listed(item(1, 'One')), {
    'item.move': { ok: false, error: { kind: 'rule', detail: 'TF401320' } }
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, locale: 'pt-BR' })
  await view.press({ label: '#1 One' })
  assert.ok(view.find({ label: 'Abrir no navegador' }))
  assert.ok(view.find({ type: 'Select', label: 'Mover para' }))
  await view.select({ type: 'Select', label: 'Mover para' }, 'New')
  assert.ok(view.find({ label: 'O Azure DevOps recusou a mudança' }))
  assert.ok(view.find({ text: 'TF401320' }))
  assert.ok(view.find({ label: 'Fechar' }))
  await view.unmount()
})

// ---------------------------------------------------------------------------------------------
// Start work

const agent = (terminalId: string, over: Partial<OpenAgent> = {}): OpenAgent => ({
  terminalId,
  agent: 'claude',
  title: '',
  workspaceId: `ws-${terminalId}`,
  workspaceName: `work-${terminalId}`,
  projectName: '',
  state: 'waiting',
  ...over
})

const startOptions = (over: Partial<Extract<StartOptionsResult, { ok: true }>> = {}): StartOptionsResult => ({
  ok: true,
  agents: [agent('t1', { title: 'Login' }), agent('t2', { agent: '', state: 'working' })],
  projects: [
    { id: 'p1', name: 'Web', hostId: 'h1' },
    { id: 'p2', name: 'Api', hostId: 'h2' }
  ],
  lastProjectId: 'p2',
  prompt: 'Fix #1 One',
  workspaceName: 'wi-1-one',
  agentKinds: ['codex', 'claude', 'kiro'],
  lastAgent: 'kiro',
  ...over
})

function starter(options: StartOptionsResult, run: unknown = { ok: true }) {
  const calls = { options: [] as unknown[], run: [] as unknown[] }
  const w = worker(configured, listed(item(1, 'One'), item(2, 'Two')), {
    'start.options': (input: unknown) => (calls.options.push(input), options),
    'start.run': (input: unknown) => (calls.run.push(input), run)
  })
  return { calls, w }
}

test('start: opening the form asks for the options with the locale and defaults to the first agent', async () => {
  const { calls, w } = starter(startOptions())
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  assert.equal(view.find({ type: 'Select', label: 'Send to' }), null)
  await view.press({ text: 'Start work' })
  assert.equal(calls.options.length, 1)
  assert.equal((calls.options[0] as { id: number }).id, 1)
  assert.ok(/^en/i.test((calls.options[0] as { locale: string }).locale))
  const select = view.find({ type: 'Select', label: 'Send to' })
  assert.equal(select?.props.value, 'agent:t1')
  assert.deepEqual(select?.props.options, [
    { value: 'agent:t1', label: '🟡 claude · work-t1 · Login' },
    { value: 'agent:t2', label: '⏳ agent · work-t2' },
    { value: 'new', label: 'New worktree' }
  ])
  assert.equal(view.find({ type: 'Textarea', label: 'Prompt' })?.props.value, 'Fix #1 One')
  assert.equal(view.find({ type: 'Select', label: 'Project' }), null)
  clean(view, host)
  await view.unmount()
})

test('start: Send to an agent sends the prompt, closes the form and collapses the item', async () => {
  const { calls, w } = starter(startOptions())
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  await view.press({ text: 'Send' })
  assert.deepEqual(calls.run, [{ id: 1, project: 'Web', prompt: 'Fix #1 One', target: { kind: 'agent', terminalId: 't1' } }])
  assert.equal(view.find({ label: 'Open in browser' }), null)
  assert.equal(view.find({ type: 'Textarea', label: 'Prompt' }), null)
  assert.ok(view.find({ text: 'Sent to claude · work-t1' }))
  // The note stays until another item opens.
  await view.press({ label: '#2 Two' })
  assert.equal(view.find({ text: 'Sent to claude · work-t1' }), null)
  clean(view, host)
  await view.unmount()
})

test('start: New worktree shows the project and the name, and sends the worktree target', async () => {
  const { calls, w } = starter(startOptions())
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  await view.select({ type: 'Select', label: 'Send to' }, 'new')
  assert.equal(view.find({ type: 'Select', label: 'Project' })?.props.value, 'p2')
  assert.equal(view.find({ type: 'Input', label: 'Worktree name' })?.props.value, 'wi-1-one')
  // The agent: the one used last, among the kinds Orca knows.
  const agentSelect = view.find({ type: 'Select', label: 'Agent' })
  assert.equal(agentSelect?.props.value, 'kiro')
  assert.deepEqual((agentSelect?.props.options as { value: string }[]).map((o) => o.value), ['codex', 'claude', 'kiro'])
  await view.select({ type: 'Select', label: 'Agent' }, 'codex')
  await view.type({ type: 'Input', label: 'Worktree name' }, 'my-tree', { replace: true })
  await view.press({ text: 'Send' })
  assert.deepEqual(calls.run, [
    {
      id: 1,
      project: 'Web',
      prompt: 'Fix #1 One',
      target: { kind: 'worktree', projectId: 'p2', hostId: 'h2', name: 'my-tree', agent: 'codex' }
    }
  ])
  assert.ok(view.find({ text: 'Worktree my-tree created with codex' }))
  clean(view, host)
  await view.unmount()
})

test('start: without agents the form starts on New worktree; no projects disables Send', async () => {
  const { w } = starter(startOptions({ agents: [], projects: [], lastProjectId: '' }))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  assert.equal(view.find({ type: 'Select', label: 'Send to' })?.props.value, 'new')
  assert.ok(view.find({ text: 'No Git project in Orca.' }))
  assert.equal(view.find({ type: 'Button', text: 'Send' })?.props.disabled, true)
  await view.unmount()
})

test('start: the edited prompt is sent, and a blank one disables Send', async () => {
  const { calls, w } = starter(startOptions())
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  await view.type({ type: 'Textarea', label: 'Prompt' }, '   ', { replace: true })
  assert.equal(view.find({ type: 'Button', text: 'Send' })?.props.disabled, true)
  await view.type({ type: 'Textarea', label: 'Prompt' }, 'Do it differently', { replace: true })
  await view.press({ text: 'Send' })
  assert.equal((calls.run[0] as { prompt: string }).prompt, 'Do it differently')
  await view.unmount()
})

test('start: Cancel, collapsing and opening another item close the form', async () => {
  const { w } = starter(startOptions())
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ type: 'Textarea', label: 'Prompt' }), null)
  assert.ok(view.find({ label: 'Open in browser' }))
  await view.press({ text: 'Start work' })
  assert.ok(view.find({ type: 'Textarea', label: 'Prompt' }))
  await view.press({ text: 'Start work' })
  assert.equal(view.find({ type: 'Textarea', label: 'Prompt' }), null)
  await view.press({ text: 'Start work' })
  await view.press({ label: '#2 Two' })
  assert.equal(view.find({ type: 'Textarea', label: 'Prompt' }), null)
  await view.unmount()
})

test('start: a capability error shows the approval callout', async () => {
  const { w } = starter({ ok: false, error: { kind: 'capability' } })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  assert.ok(view.find({ label: 'Orca has not allowed this yet' }))
  assert.ok(view.find({ text: /Approve the plugin’s new permissions in Settings → Plugins\./ }))
  await view.unmount()
})

test('start: an Orca refusal and an Azure error are shown', async () => {
  const orca = starter({ ok: false, error: { kind: 'orca', detail: 'no such repo' } })
  let host = mockHost({ requests: orca.w.requests })
  let view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  assert.ok(view.find({ label: 'Orca refused' }))
  assert.ok(view.find({ text: 'no such repo' }))
  await view.unmount()

  const azure = starter({ ok: false, error: { kind: 'writeScope', detail: 'HTTP 403' } })
  host = mockHost({ requests: azure.w.requests })
  view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  assert.ok(view.find({ text: 'HTTP 403' }))
  await view.unmount()
})

test('start: a failed send keeps the form with the error', async () => {
  const { w } = starter(startOptions(), { ok: false, error: { kind: 'orca', detail: 'terminal gone' } })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  await view.press({ text: 'Send' })
  assert.ok(view.find({ type: 'Textarea', label: 'Prompt' }))
  assert.ok(view.find({ label: 'Orca refused' }))
  assert.ok(view.find({ text: 'terminal gone' }))
  assert.ok(view.find({ label: 'Open in browser' }))
  assert.equal(view.find({ text: /^Sent to/ }), null)
  await view.unmount()
})

test('start: speaks Brazilian Portuguese', async () => {
  const { calls, w } = starter(startOptions())
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, locale: 'pt-BR' })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Iniciar trabalho' })
  assert.equal((calls.options[0] as { locale: string }).locale, 'pt-BR')
  const select = view.find({ type: 'Select', label: 'Enviar para' })
  assert.deepEqual((select?.props.options as { label: string }[]).map((o) => o.label), [
    '🟡 claude · work-t1 · Login',
    '⏳ agente · work-t2',
    'Novo worktree'
  ])
  assert.ok(view.find({ type: 'Textarea', label: 'Prompt' }))
  await view.select({ type: 'Select', label: 'Enviar para' }, 'new')
  assert.ok(view.find({ type: 'Select', label: 'Projeto' }))
  assert.ok(view.find({ type: 'Input', label: 'Nome do worktree' }))
  assert.ok(view.find({ type: 'Select', label: 'Agente' }))
  await view.press({ text: 'Enviar' })
  assert.ok(view.find({ text: 'Worktree wi-1-one criado com kiro' }))
  await view.unmount()
})

test('start: the Board tab has the button and shows the note', async () => {
  const calls: unknown[] = []
  const w = worker(withBoard, listed(), {
    'board.get': boardResult(),
    'start.options': startOptions(),
    'start.run': (input: unknown) => (calls.push(input), { ok: true })
  })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, persisted: { plugin: { activeTab: 'board' } } })
  await view.press({ label: '#2 Card 2' })
  await view.press({ text: 'Start work' })
  await view.press({ text: 'Send' })
  assert.equal(calls.length, 1)
  assert.ok(view.find({ text: 'Sent to claude · work-t1' }))
  await view.unmount()
})

// ---------------------------------------------------------------------------------------------
// Search

test('search: the magnifier opens a box that filters by number or title, and closing it clears it', async () => {
  const w = worker(
    { ...configured, groupBy: 'state' },
    listed(
      item(101, 'Ajustar integração', { state: 'New', stateCategory: 'Proposed' }),
      item(202, 'Login lento'),
      item(303, 'Outra integracao')
    )
  )
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, persisted: { plugin: { collapsedGroups: { 'state:Active': true } } } })
  assert.equal(view.find({ type: 'Input', label: 'Search by number or title' }), null)
  await view.press({ label: 'Search' })
  await view.type({ type: 'Input', label: 'Search by number or title' }, 'INTEGRACAO')
  // Matches in a folded group show anyway; the rest of the groups go.
  assert.deepEqual(titles(view, 'Collapsible'), ['New · 1', 'Active · 1'])
  assert.ok(view.find({ label: '#303 Outra integracao' }))
  assert.equal(view.find({ label: '#202 Login lento' }), null)

  await view.type({ type: 'Input', label: 'Search by number or title' }, '#20', { replace: true })
  assert.deepEqual(titles(view, 'Collapsible'), ['Active · 1'])
  assert.ok(view.find({ label: '#202 Login lento' }))

  await view.type({ type: 'Input', label: 'Search by number or title' }, 'nada', { replace: true })
  assert.ok(view.find({ text: 'No item matches the search.' }))

  await view.press({ label: 'Search' })
  assert.equal(view.find({ type: 'Input', label: 'Search by number or title' }), null)
  assert.deepEqual(titles(view, 'Collapsible'), ['New · 1', 'Active · 2'])
  // Searching never asked the worker again, nor changed the remembered folds.
  assert.equal(w.state.listCalls, 1)
  assert.ok(JSON.stringify(view.persisted.plugin).includes('"state:Active":true'))
  clean(view, host)
  await view.unmount()
})

test('search: on the board only the columns with matches show, open', async () => {
  const w = worker(withBoard, listed(), { 'board.get': boardResult() })
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, persisted: { plugin: { activeTab: 'board' } } })
  await view.press({ label: 'Search' })
  await view.type({ type: 'Input', label: 'Search by number or title' }, '4')
  // Card 4 lives in the outgoing column, folded by default: it opens while searching.
  assert.deepEqual(titles(view, 'Collapsible'), ['Closed · 1'])
  assert.ok(view.find({ label: '#4 Card 4' }))

  await view.type({ type: 'Input', label: 'Search by number or title' }, 'card', { replace: true })
  assert.deepEqual(titles(view, 'Collapsible'), ['New · 1', 'Doing · 2/3', 'Closed · 1', 'Other · 1'])
  await view.type({ type: 'Input', label: 'Search by number or title' }, 'zzz', { replace: true })
  assert.ok(view.find({ text: 'No item matches the search.' }))
  assert.deepEqual(titles(view, 'Collapsible'), [])
  clean(view, host)
  await view.unmount()
})

test('search: speaks Brazilian Portuguese', async () => {
  const w = worker(configured, listed(item(1, 'Um')))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host, locale: 'pt-BR' })
  await view.press({ label: 'Buscar' })
  const input = view.find({ type: 'Input', label: 'Buscar por número ou título' })
  assert.equal(input?.props.placeholder, 'Número ou título')
  await view.type({ type: 'Input', label: 'Buscar por número ou título' }, 'x')
  assert.ok(view.find({ text: 'Nenhum item corresponde à busca.' }))
  clean(view, host)
  await view.unmount()
})

test('actions: the Move to select is as wide as its longest option, within bounds', () => {
  assert.equal(panel.selectWidth([{ label: 'New' }]), 120)
  const long = panel.selectWidth([{ label: 'New' }, { label: 'In Progress · Em andamento' }])
  assert.ok(long >= 26 * 7.5 + 48 && long <= 320)
  assert.equal(panel.selectWidth([{ label: 'x'.repeat(200) }]), 320)
})

test('start: an agent is named by its Orca project, or by its workspace outside any project', async () => {
  const { w } = starter(startOptions({ agents: [agent('t1', { projectName: 'Web', workspaceName: 'main' }), agent('t2')] }))
  const host = mockHost({ requests: w.requests })
  const view = await mount(panel, { host })
  await view.press({ label: '#1 One' })
  await view.press({ text: 'Start work' })
  const select = view.find({ type: 'Select', label: 'Send to' })
  assert.deepEqual((select?.props.options as { label: string }[]).map((o) => o.label).slice(0, 2), [
    '🟡 claude · Web',
    '🟡 claude · work-t2'
  ])
  await view.press({ text: 'Send' })
  assert.ok(view.find({ text: 'Sent to claude · Web' }))
  clean(view, host)
  await view.unmount()
})
