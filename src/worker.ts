// The plugin's worker: every Azure DevOps call happens here, because the panel's frame has no
// network.
// The PAT lives only in Orca's encrypted secrets (secrets:own). It is never logged, never posted
// and never returned to the panel. It is stored with the organization that accepted it and only
// ever sent there: after the organization changes, the panel asks for a PAT again.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  API_VERSION,
  cleanTitle,
  createMetadataCache,
  listAssigned,
  listProjects,
  parseOrganization,
  parseStates,
  request,
  workItemUrl,
  type Connection,
  type FetchLike
} from './azure'
import { listChildren } from './children'
import { getBoard, listBoards, listTeams } from './board'
import { moveItem, parseMove } from './move'
import { buildPrompt, htmlToText, workspaceNameFor } from './start'
import type {
  BoardRef,
  BoardResult,
  BoardsResult,
  ChildrenResult,
  ConfigView,
  ErrorKind,
  GroupBy,
  HideClosed,
  ListResult,
  MoveResult,
  OpenAgent,
  OrcaError,
  OrcaProject,
  Prefs,
  Project,
  ProjectsResult,
  StartOptionsResult,
  StartResult,
  StartTarget,
  TeamsResult
} from './protocol'

const PAT = 'pat'
const PROJECTS = 'projects'
const BOARD = 'board'
const START_PROJECTS = 'startProjects'
const START_AGENT = 'startAgent'
/** Always offered for a new worktree, after the kinds the person has used. */
const DEFAULT_AGENT_KINDS = ['claude', 'codex', 'kiro', 'gemini']
const MAX_SESSIONS = 200
const MAX_AGENT_WORKSPACES = 40
const MAX_PROMPT = 20000
const START_FIELDS =
  'System.Title,System.AreaPath,System.WorkItemType,System.TeamProject,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria,Microsoft.VSTS.TCM.ReproSteps'
const GROUP_BY: readonly GroupBy[] = ['none', 'state', 'boardColumn']
const REFRESH_MINUTES: readonly number[] = [0, 5, 15, 30]
const DEFAULT_REFRESH_MINUTES = 5

/** The secret's shape: the PAT and the organization (lower case) that accepted it. */
type StoredPat = { organization: string; pat: string }

type Settings = {
  organization: string
  hiddenStates: string[]
  groupBy: GroupBy
  stripAreaPrefix: boolean
  hideClosed: HideClosed
  refreshMinutes: number
}

type ProjectFilter = { all: boolean; selected: Project[] }

function fail(kind: ErrorKind): ListResult {
  return { ok: false, error: { kind } }
}

function failure(kind: ErrorKind): { ok: false; error: { kind: ErrorKind } } {
  return { ok: false, error: { kind } }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isGroupBy(value: unknown): value is GroupBy {
  return GROUP_BY.includes(value as GroupBy)
}

const HIDE_CLOSED: readonly HideClosed[] = ['off', 'children', 'all']

function isHideClosed(value: unknown): value is HideClosed {
  return HIDE_CLOSED.includes(value as HideClosed)
}

/** Keeps the well-formed projects of a stored or received list, once each. */
function cleanProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: Project[] = []
  for (const p of value as { id?: unknown; name?: unknown }[]) {
    const name = str(p?.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ id: str(p?.id) || name, name })
  }
  return out
}

/** An error carrying the code `invalid_params`, for input the panel should not have sent. */
function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

const BOARD_KEYS = ['projectId', 'projectName', 'teamId', 'teamName', 'boardId', 'boardName'] as const

/** A BoardRef with all six fields non-empty strings; null for anything else. */
function cleanBoard(value: unknown): BoardRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const out = {} as Record<string, string>
  for (const key of BOARD_KEYS) {
    const text = str(raw[key])
    if (!text) return null
    out[key] = text
  }
  return out as BoardRef
}

/** A host error as the panel shows it: a missing capability, or Orca refusing. */
function orcaError(method: string, error: unknown): OrcaError {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'capability_denied' || code === 'not_permitted') return { kind: 'capability', detail: method }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'orca', detail: message }
}

/** Tags a rejected host call with its method, so the mapping above can name it. */
class HostCallError extends Error {
  constructor(
    readonly method: string,
    readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export default function activate(orca: OrcaWorkerApi): void {
  // Read at call time so tests can swap globalThis.fetch.
  const fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init)
  // Work item types per project, for an hour; lives and dies with the worker.
  const cache = createMetadataCache()
  // The PAT owner's identity id per organization; asked once.
  const meCache = new Map<string, string>()

  async function readSettings(): Promise<Settings> {
    const all = await orca.settings.get()
    return {
      organization: str(all.organization),
      hiddenStates: parseStates(all.hiddenStates),
      groupBy: isGroupBy(all.groupBy) ? all.groupBy : 'state',
      stripAreaPrefix: typeof all.stripAreaPrefix === 'boolean' ? all.stripAreaPrefix : true,
      hideClosed: isHideClosed(all.hideClosed) ? all.hideClosed : 'off',
      refreshMinutes: REFRESH_MINUTES.includes(all.refreshMinutes as number)
        ? (all.refreshMinutes as number)
        : DEFAULT_REFRESH_MINUTES
    }
  }

  /** Absent or unreadable: every project. */
  async function readProjects(): Promise<ProjectFilter> {
    const raw = (await orca.storage.get(PROJECTS)) as { all?: unknown; selected?: unknown } | null
    if (!raw || typeof raw !== 'object') return { all: true, selected: [] }
    return { all: raw.all !== false, selected: cleanProjects(raw.selected) }
  }

  async function writeProjects(filter: ProjectFilter): Promise<void> {
    await orca.storage.set(PROJECTS, { all: filter.all, selected: filter.selected })
  }

  async function readBoard(): Promise<BoardRef | null> {
    return cleanBoard(await orca.storage.get(BOARD))
  }

  async function protection(): Promise<ConfigView['protection']> {
    try {
      return (await orca.host.call('secrets.protection')).status
    } catch {
      // If the status cannot be read, assume a keyring: secrets.set will tell.
      return 'os-keyring'
    }
  }

  /** The stored PAT, only when it was accepted by this organization. */
  async function patFor(organization: string | null): Promise<string | null> {
    if (!organization) return null
    const raw = await orca.secrets.get(PAT)
    if (!raw) return null
    try {
      const stored = JSON.parse(raw) as Partial<StoredPat>
      const matches = stored.organization === organization.toLowerCase()
      return matches && typeof stored.pat === 'string' && stored.pat ? stored.pat : null
    } catch {
      return null
    }
  }

  async function configView(): Promise<ConfigView> {
    const settings = await readSettings()
    const filter = await readProjects()
    return {
      organization: settings.organization,
      hasPat: Boolean(await patFor(parseOrganization(settings.organization))),
      protection: await protection(),
      allProjects: filter.all,
      projects: filter.selected,
      groupBy: settings.groupBy,
      stripAreaPrefix: settings.stripAreaPrefix,
      hideClosed: settings.hideClosed,
      hiddenStates: settings.hiddenStates,
      refreshMinutes: settings.refreshMinutes,
      board: await readBoard()
    }
  }

  async function changed(): Promise<ConfigView> {
    const view = await configView()
    orca.panels.post('config.changed', view)
    return view
  }

  function connection(
    organization: string,
    settings: Settings,
    filter: ProjectFilter,
    pat: string
  ): Connection {
    return {
      organization,
      pat,
      hiddenStates: settings.hiddenStates,
      allProjects: filter.all,
      projects: filter.selected.map((p) => p.name),
      stripAreaPrefix: settings.stripAreaPrefix
    }
  }

  async function run(conn: Connection, signal?: AbortSignal): Promise<ListResult> {
    const result = await listAssigned(conn, fetchImpl, { signal, cache, warn: (m) => orca.log(m) })
    if (!result.ok) {
      const { kind, detail } = result.error
      orca.log(`list failed: ${kind}${detail ? ` (${detail})` : ''}`)
    }
    return result
  }

  orca.panels.handle('config.get', () => configView())

  orca.panels.handle('items.list', async (_input, { signal }) => {
    const settings = await readSettings()
    const organization = parseOrganization(settings.organization)
    if (settings.organization && !organization) return fail('invalidOrganization')
    const pat = await patFor(organization)
    if (!organization || !pat) return fail('notConfigured')
    return run(connection(organization, settings, await readProjects(), pat), signal)
  })

  orca.panels.handle('projects.list', async (_input, { signal }): Promise<ProjectsResult> => {
    const settings = await readSettings()
    const organization = parseOrganization(settings.organization)
    if (settings.organization && !organization) return failure('invalidOrganization')
    const pat = await patFor(organization)
    if (!organization || !pat) return failure('notConfigured')

    const filter = await readProjects()
    const result = await listProjects(connection(organization, settings, filter, pat), fetchImpl, { signal })
    if (!result.ok) {
      orca.log(`projects failed: ${result.error.kind}${result.error.detail ? ` (${result.error.detail})` : ''}`)
      return result
    }
    if (!result.complete) {
      orca.log('projects: the PAT lacks Project and Team (Read), listing the projects of the assigned items')
      return result
    }
    // A renamed project keeps its id: bring the stored names along so the WIQL filter stays right.
    const names = new Map(result.projects.map((p) => [p.id, p.name]))
    const selected = filter.selected.map((p) => ({ id: p.id, name: names.get(p.id) ?? p.name }))
    if (selected.some((p, index) => p.name !== filter.selected[index]!.name)) {
      await writeProjects({ all: filter.all, selected })
      await changed()
    }
    return result
  })

  /** The organization and PAT for a board request, or the error to answer. */
  async function credentials(): Promise<
    | { ok: true; organization: string; pat: string; settings: Settings }
    | { ok: false; error: { kind: ErrorKind } }
  > {
    const settings = await readSettings()
    const organization = parseOrganization(settings.organization)
    if (settings.organization && !organization) return failure('invalidOrganization')
    const pat = await patFor(organization)
    if (!organization || !pat) return failure('notConfigured')
    return { ok: true, organization, pat, settings }
  }

  function logFailure(what: string, error: { kind: ErrorKind; detail?: string }): void {
    orca.log(`${what} failed: ${error.kind}${error.detail ? ` (${error.detail})` : ''}`)
  }

  orca.panels.handle('teams.list', async (input, { signal }): Promise<TeamsResult> => {
    const projectId = str(input?.projectId)
    if (!projectId) throw invalid('projectId is required')
    const auth = await credentials()
    if (!auth.ok) return auth
    const conn = connection(auth.organization, auth.settings, await readProjects(), auth.pat)
    const result = await listTeams(conn, projectId, fetchImpl, { signal })
    if (!result.ok) logFailure('teams', result.error)
    return result
  })

  orca.panels.handle('boards.list', async (input, { signal }): Promise<BoardsResult> => {
    const projectId = str(input?.projectId)
    const teamId = str(input?.teamId)
    if (!projectId || !teamId) throw invalid('projectId and teamId are required')
    const auth = await credentials()
    if (!auth.ok) return auth
    const conn = connection(auth.organization, auth.settings, await readProjects(), auth.pat)
    const result = await listBoards(conn, projectId, teamId, fetchImpl, { signal })
    if (!result.ok) logFailure('boards', result.error)
    return result
  })

  orca.panels.handle('board.get', async (_input, { signal }): Promise<BoardResult> => {
    const board = await readBoard()
    if (!board) return failure('boardNotConfigured')
    const auth = await credentials()
    if (!auth.ok) return auth
    const conn = connection(auth.organization, auth.settings, await readProjects(), auth.pat)
    const result = await getBoard(conn, board, fetchImpl, {
      signal,
      cache,
      meCache,
      warn: (m) => orca.log(m)
    })
    if (!result.ok) logFailure('board', result.error)
    return result
  })

  orca.panels.handle('item.move', async (input, { signal }): Promise<MoveResult> => {
    const move = parseMove(input)
    if (!move) throw invalid('id must be a positive integer and target a state or a column with done')
    const auth = await credentials()
    if (!auth.ok) return auth
    const conn = connection(auth.organization, auth.settings, await readProjects(), auth.pat)
    // The board is read only for a column target, where its absence is an error.
    const result = await moveItem(conn, await readBoard(), move.id, move.target, fetchImpl, { signal })
    if (!result.ok) logFailure('move', result.error)
    return result
  })

  orca.panels.handle('item.children', async (input, { signal }): Promise<ChildrenResult> => {
    const id = (input as { id?: unknown } | null)?.id
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw invalid('id must be a positive integer')
    const auth = await credentials()
    if (!auth.ok) return auth
    const conn = connection(auth.organization, auth.settings, await readProjects(), auth.pat)
    const result = await listChildren(conn, id, fetchImpl, { signal, cache, meCache, warn: (m) => orca.log(m) })
    if (!result.ok) logFailure('children', result.error)
    return result
  })

  /** A host call whose rejection names the method. */
  async function host<T>(method: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      throw new HostCallError(method, error)
    }
  }

  function startFailure(error: unknown): { ok: false; error: OrcaError } {
    const result =
      error instanceof HostCallError ? orcaError(error.method, error.cause) : orcaError('', error)
    orca.log(`start failed: ${result.kind}${result.kind === 'capability' ? ` (${result.detail})` : ''}`)
    return { ok: false, error: result }
  }

  async function listAgents(workspaceId: string) {
    return (await host('agents.list', () => orca.host.call('agents.list', { workspaceId }))).agents
  }

  async function gatherAgents(): Promise<OpenAgent[]> {
    const { workspaces } = await host('workspace.list', () => orca.host.call('workspace.list', { includeStatus: true }))
    const withTerminals = workspaces
      .filter((w) => !w.status || w.status.terminalCount > 0)
      .slice(0, MAX_AGENT_WORKSPACES)
    const lists = await Promise.all(
      withTerminals.map(async (w) => {
        let agents: Awaited<ReturnType<typeof listAgents>>
        try {
          agents = await listAgents(w.id)
        } catch (error) {
          // A missing capability concerns every workspace; any other failure (a workspace removed
          // meanwhile, an SSH host offline) only skips this one.
          if (error instanceof HostCallError && orcaError(error.method, error.cause).kind === 'capability') throw error
          orca.log('start: skipped a workspace whose agents could not be read')
          return []
        }
        return agents.flatMap((a): OpenAgent[] =>
          a.terminalId
            ? [
                {
                  terminalId: a.terminalId,
                  agent: a.agent ?? '',
                  title: a.title ?? '',
                  workspaceId: w.id,
                  workspaceName: w.name,
                  projectName: w.project ?? '',
                  state: a.state
                }
              ]
            : []
        )
      })
    )
    const place = (a: OpenAgent) => a.projectName || a.workspaceName
    const idle = (a: OpenAgent) => (a.state === 'waiting' || a.state === 'done' ? 0 : 1)
    return lists.flat().sort((a, b) => idle(a) - idle(b) || place(a).localeCompare(place(b)))
  }

  /**
   * The agent kinds to offer: from Orca's session history (in the order Orca returns it), then the
   * open agents, then the usual ones. When the history cannot be read, the rest remains.
   */
  async function gatherAgentKinds(open: readonly OpenAgent[]): Promise<string[]> {
    let sessions: { agent: string }[] = []
    try {
      sessions = (await orca.host.call('agent.listSessions', { limit: MAX_SESSIONS })).sessions
    } catch (error) {
      const reason = (error as { code?: unknown; message?: unknown })?.code ?? (error as Error)?.message
      orca.log(`start: agent session history unavailable (${String(reason)})`)
    }
    const kinds: string[] = []
    for (const kind of [...sessions.map((s) => s.agent), ...open.map((a) => a.agent), ...DEFAULT_AGENT_KINDS]) {
      const name = typeof kind === 'string' ? kind.trim() : ''
      if (name && !kinds.includes(name)) kinds.push(name)
    }
    return kinds
  }

  async function gatherProjects(): Promise<OrcaProject[]> {
    const { projects } = await host('project.list', () => orca.host.call('project.list'))
    return projects
      .filter((p) => p.kind === 'git' && !p.hidden)
      .map((p) => ({ id: p.id, name: p.name, hostId: p.hostId ?? 'local' }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async function readStartProjects(): Promise<Record<string, string>> {
    const raw = await orca.storage.get(START_PROJECTS)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value
    return out
  }

  orca.panels.handle('start.options', async (input, { signal }): Promise<StartOptionsResult> => {
    const id = input?.id
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw invalid('id must be a positive integer')
    if (typeof input.locale !== 'string') throw invalid('locale must be a string')
    const auth = await credentials()
    if (!auth.ok) return auth
    const org = `https://dev.azure.com/${encodeURIComponent(auth.organization)}`
    const azure = request(
      fetchImpl,
      'GET',
      `${org}/_apis/wit/workitems/${id}?fields=${START_FIELDS}&api-version=${API_VERSION}`,
      undefined,
      auth.pat,
      signal
    )
    const orcaData = Promise.all([
      gatherAgents().then(async (agents) => [agents, await gatherAgentKinds(agents)] as const),
      gatherProjects()
    ]).then(
      (data) => ({ ok: true as const, data }),
      (error: unknown) => ({ ok: false as const, error })
    )
    const [answer, gathered] = await Promise.all([azure, orcaData])
    if (!answer.ok) {
      logFailure('start', answer.error)
      return answer
    }
    if (!gathered.ok) return startFailure(gathered.error)
    const [[agents, agentKinds], projects] = gathered.data
    const stored = await orca.storage.get(START_AGENT)
    const lastAgent = typeof stored === 'string' && agentKinds.includes(stored) ? stored : ''

    const fields = (answer.json as { fields?: Record<string, unknown> } | null)?.fields ?? {}
    const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string) : '')
    const title = text('System.Title')
    const project = text('System.TeamProject')
    const prompt = buildPrompt(
      {
        id,
        type: text('System.WorkItemType'),
        title,
        url: workItemUrl(auth.organization, project, id),
        organization: auth.organization,
        project,
        description: htmlToText(text('System.Description')),
        acceptanceCriteria: htmlToText(text('Microsoft.VSTS.Common.AcceptanceCriteria')),
        reproSteps: htmlToText(text('Microsoft.VSTS.TCM.ReproSteps'))
      },
      input.locale
    )
    const lastProjectId = project ? ((await readStartProjects())[project] ?? '') : ''
    // The worktree name uses the title without the leading [area]; the prompt keeps the full title.
    const shortTitle = cleanTitle(title, text('System.AreaPath'))
    return {
      ok: true,
      agents,
      projects,
      lastProjectId,
      prompt,
      workspaceName: workspaceNameFor(id, shortTitle),
      agentKinds,
      lastAgent
    }
  })

  function parseTarget(value: unknown): StartTarget | null {
    if (!value || typeof value !== 'object') return null
    const t = value as Record<string, unknown>
    if (t.kind === 'agent' && nonEmpty(t.terminalId)) return { kind: 'agent', terminalId: t.terminalId }
    if (t.kind === 'worktree' && nonEmpty(t.projectId) && nonEmpty(t.hostId) && nonEmpty(t.name) && nonEmpty(t.agent)) {
      return { kind: 'worktree', projectId: t.projectId, hostId: t.hostId, name: t.name, agent: t.agent }
    }
    return null
  }

  orca.panels.handle('start.run', async (input): Promise<StartResult> => {
    const id = input?.id
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw invalid('id must be a positive integer')
    if (typeof input.project !== 'string') throw invalid('project must be a string')
    if (!nonEmpty(input.prompt) || input.prompt.length > MAX_PROMPT) {
      throw invalid(`prompt must be a non-empty string of at most ${MAX_PROMPT} characters`)
    }
    const target = parseTarget(input.target)
    if (!target) throw invalid('target must be an agent with terminalId, or a worktree with projectId, hostId, name and agent')
    const prompt = input.prompt
    try {
      if (target.kind === 'agent') {
        const sent = await host('terminal.sendText', () =>
          orca.host.call('terminal.sendText', { terminalId: target.terminalId, text: prompt, enter: true })
        )
        if (!sent.accepted) {
          orca.log('start failed: orca (the terminal did not accept the text)')
          return { ok: false, error: { kind: 'orca', detail: 'the terminal did not accept the text' } }
        }
        try {
          await orca.host.call('terminal.focus', { terminalId: target.terminalId })
        } catch {
          // Showing the terminal is a courtesy: the prompt was sent.
        }
        return { ok: true }
      }
      await host('workspace.create', () =>
        orca.host.call('workspace.create', {
          projectId: target.projectId,
          hostId: target.hostId,
          name: target.name,
          agent: target.agent,
          prompt,
          open: true
        })
      )
      // The worktree exists now: remembering the choices must not turn this into a failure, or a
      // retry would create a second one.
      try {
        await orca.storage.set(START_AGENT, target.agent)
        if (input.project) {
          const map = await readStartProjects()
          await orca.storage.set(START_PROJECTS, { ...map, [input.project]: target.projectId })
        }
      } catch {
        orca.log('start: could not remember the agent and project')
      }
      return { ok: true }
    } catch (error) {
      return startFailure(error)
    }
  })

  // Every field is checked before anything is written, so a refused call changes nothing. An
  // unknown groupBy (or a value of the wrong type) is refused with `invalid_params` rather than
  // ignored: the panel only sends what it offers, so a bad value is a bug worth seeing.
  orca.panels.handle('prefs.set', async (input) => {
    const prefs: Prefs = input ?? {}
    if (prefs.groupBy !== undefined && !isGroupBy(prefs.groupBy)) throw invalid('unknown groupBy')
    if (prefs.stripAreaPrefix !== undefined && typeof prefs.stripAreaPrefix !== 'boolean') {
      throw invalid('stripAreaPrefix must be a boolean')
    }
    if (prefs.hideClosed !== undefined && !isHideClosed(prefs.hideClosed)) throw invalid('unknown hideClosed')
    if (prefs.allProjects !== undefined && typeof prefs.allProjects !== 'boolean') {
      throw invalid('allProjects must be a boolean')
    }
    if (prefs.projects !== undefined && !Array.isArray(prefs.projects)) {
      throw invalid('projects must be a list')
    }
    if (prefs.refreshMinutes !== undefined && !REFRESH_MINUTES.includes(prefs.refreshMinutes)) {
      throw invalid('refreshMinutes must be 0, 5, 15 or 30')
    }
    if (prefs.board !== undefined && prefs.board !== null && !cleanBoard(prefs.board)) {
      throw invalid('board must be null or have projectId, projectName, teamId, teamName, boardId and boardName')
    }

    if (prefs.board === null) await orca.storage.delete(BOARD)
    else if (prefs.board !== undefined) await orca.storage.set(BOARD, cleanBoard(prefs.board)!)
    if (prefs.allProjects !== undefined || prefs.projects !== undefined) {
      const current = await readProjects()
      // The stored name wins for a project already stored: projects.list renames it there, and
      // the panel's draft may still hold the name from before.
      const stored = new Map(current.selected.map((p) => [p.id, p.name]))
      await writeProjects({
        all: prefs.allProjects ?? current.all,
        selected:
          prefs.projects !== undefined
            ? cleanProjects(prefs.projects).map((p) => ({ id: p.id, name: stored.get(p.id) ?? p.name }))
            : current.selected
      })
    }
    const current = await readSettings()
    // Only real changes, so settings.onDidChange does not repeat the post below.
    if (prefs.groupBy !== undefined && prefs.groupBy !== current.groupBy) {
      await orca.settings.set('groupBy', prefs.groupBy)
    }
    if (prefs.stripAreaPrefix !== undefined && prefs.stripAreaPrefix !== current.stripAreaPrefix) {
      await orca.settings.set('stripAreaPrefix', prefs.stripAreaPrefix)
    }
    if (prefs.hideClosed !== undefined && prefs.hideClosed !== current.hideClosed) {
      await orca.settings.set('hideClosed', prefs.hideClosed)
    }
    if (prefs.refreshMinutes !== undefined && prefs.refreshMinutes !== current.refreshMinutes) {
      await orca.settings.set('refreshMinutes', prefs.refreshMinutes)
    }
    return changed()
  })

  orca.panels.handle('config.save', async (input, { signal }) => {
    const current = await readSettings()
    const typedOrg = str(input.organization)
    const organization = parseOrganization(typedOrg)
    if (!organization) return fail(typedOrg ? 'invalidOrganization' : 'notConfigured')

    const newPat = str(input.pat)
    // Without a new PAT, reuse the stored one only for the organization that accepted it.
    const pat = newPat || (await patFor(organization))
    if (!pat) return fail('notConfigured')
    if (newPat && (await protection()) === 'unavailable') return fail('secretsUnavailable')

    // The project filter belongs to one organization: another one starts from every project.
    const sameOrganization = organization.toLowerCase() === (parseOrganization(current.organization) ?? '').toLowerCase()
    const filter: ProjectFilter = sameOrganization ? await readProjects() : { all: true, selected: [] }

    // Nothing is saved until Azure DevOps accepts the values.
    const result = await run(connection(organization, current, filter, pat), signal)
    if (!result.ok) return result

    if (newPat) {
      try {
        const stored: StoredPat = { organization: organization.toLowerCase(), pat: newPat }
        await orca.secrets.set(PAT, JSON.stringify(stored))
      } catch {
        return fail('secretsUnavailable')
      }
      // A new PAT may have other scopes and another owner: forget what was learned with the old one.
      cache.clear()
      meCache.clear()
    }
    if (!sameOrganization) {
      await writeProjects(filter)
      // The board belongs to a team of the old organization.
      await orca.storage.delete(BOARD)
    }
    if (organization !== current.organization) {
      await orca.settings.set('organization', organization)
    }
    await changed()
    return result
  })

  orca.panels.handle('pat.clear', async () => {
    await orca.secrets.delete(PAT)
    meCache.clear()
    return changed()
  })

  // A setting changed (in Orca's Settings or by prefs.set/config.save): tell the open panels.
  orca.settings.onDidChange(() => {
    void changed()
  })
}
