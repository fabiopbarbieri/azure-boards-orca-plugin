// The plugin's worker: every Azure DevOps call happens here, because the panel's frame has no
// network. Orca transpiles this file when it loads it; a save restarts the worker.
// The PAT lives only in Orca's encrypted secrets (secrets:own). It is never logged, never posted
// and never returned to the panel. It is stored with the organization that accepted it and only
// ever sent there: after the organization changes, the panel asks for a PAT again.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  createMetadataCache,
  listAssigned,
  listProjects,
  parseOrganization,
  parseStates,
  type Connection,
  type FetchLike
} from './azure'
import { getBoard, listBoards, listTeams } from './board'
import { moveItem, parseMove } from './move'
import type {
  BoardRef,
  BoardResult,
  BoardsResult,
  ConfigView,
  ErrorKind,
  GroupBy,
  ListResult,
  MoveResult,
  Prefs,
  Project,
  ProjectsResult,
  TeamsResult
} from './protocol'

const PAT = 'pat'
const PROJECTS = 'projects'
const BOARD = 'board'
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

/** A refusal the panel sees with `invalid_params` (any thrown error with a host code reaches it). */
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
      // Older hosts without the method: secrets.set will tell.
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

  // Every field is checked before anything is written, so a refused call changes nothing. An
  // unknown groupBy (or a value of the wrong type) is refused with `invalid_params` rather than
  // ignored: the panel only sends what it offers, so a bad value is a bug worth seeing.
  orca.panels.handle('prefs.set', async (input) => {
    const prefs: Prefs = input ?? {}
    if (prefs.groupBy !== undefined && !isGroupBy(prefs.groupBy)) throw invalid('unknown groupBy')
    if (prefs.stripAreaPrefix !== undefined && typeof prefs.stripAreaPrefix !== 'boolean') {
      throw invalid('stripAreaPrefix must be a boolean')
    }
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
      await writeProjects({
        all: prefs.allProjects ?? current.all,
        selected: prefs.projects !== undefined ? cleanProjects(prefs.projects) : current.selected
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
    const sameOrganization = organization.toLowerCase() === current.organization.toLowerCase()
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
      // A new PAT may have other scopes: forget the failures remembered with the old one.
      cache.clear()
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
    return changed()
  })

  // Someone changed a setting in Orca's Settings: open panels reload.
  orca.settings.onDidChange(() => {
    void changed()
  })
}
