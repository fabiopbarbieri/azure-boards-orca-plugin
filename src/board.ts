// The team board: teams, boards and the items of the current iteration. Pure like azure.ts: it
// takes `fetch` as an argument and never touches Orca.
import {
  API_VERSION,
  FIELDS,
  fetchLinks,
  MAX_ITEMS,
  organizationUrl,
  projectTypes,
  request,
  toItem,
  wiqlString,
  type Connection,
  type FetchLike,
  type ListOptions,
  type RawItem
} from './azure'
import type {
  BoardColumn,
  BoardItem,
  BoardRef,
  BoardResult,
  BoardSummary,
  BoardsResult,
  ListError,
  Team,
  TeamsResult
} from './protocol'

type Options = ListOptions & {
  /** The PAT owner's identity id per organization (lower case), kept by the worker. */
  meCache?: Map<string, string>
}

const COLUMN_TYPES: readonly BoardColumn['columnType'][] = ['incoming', 'inProgress', 'outgoing']

function seg(value: string): string {
  return encodeURIComponent(value)
}

/** The teams of a project, by name. A refused PAT or a missing scope both read as `scope`. */
export async function listTeams(
  conn: Connection,
  projectId: string,
  fetchImpl: FetchLike,
  options: { signal?: AbortSignal } = {}
): Promise<TeamsResult> {
  const url = `${organizationUrl(conn.organization)}/_apis/projects/${seg(projectId)}/teams?api-version=${API_VERSION}&$top=500`
  const answer = await request(fetchImpl, 'GET', url, undefined, conn.pat, options.signal)
  if (!answer.ok) {
    const { kind } = answer.error
    return { ok: false, error: kind === 'auth' ? { ...answer.error, kind: 'scope' } : answer.error }
  }
  const value = (answer.json as { value?: { id?: unknown; name?: unknown }[] })?.value ?? []
  const teams: Team[] = []
  for (const t of value) {
    if (typeof t?.id === 'string' && t.id && typeof t.name === 'string' && t.name) {
      teams.push({ id: t.id, name: t.name })
    }
  }
  teams.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, teams }
}

/** The boards of a team (one per backlog level), in the API's order. */
export async function listBoards(
  conn: Connection,
  projectId: string,
  teamId: string,
  fetchImpl: FetchLike,
  options: { signal?: AbortSignal } = {}
): Promise<BoardsResult> {
  const url = `${organizationUrl(conn.organization)}/${seg(projectId)}/${seg(teamId)}/_apis/work/boards?api-version=${API_VERSION}`
  const answer = await request(fetchImpl, 'GET', url, undefined, conn.pat, options.signal)
  if (!answer.ok) return { ok: false, error: answer.error }
  const value = (answer.json as { value?: { id?: unknown; name?: unknown }[] })?.value ?? []
  const boards: BoardSummary[] = []
  for (const b of value) {
    if (typeof b?.id === 'string' && b.id && typeof b.name === 'string' && b.name) {
      boards.push({ id: b.id, name: b.name })
    }
  }
  return { ok: true, boards }
}

type RawColumn = {
  id?: unknown
  name?: unknown
  itemLimit?: unknown
  stateMappings?: unknown
  isSplit?: unknown
  columnType?: unknown
}

export type BoardInfo = {
  columns: BoardColumn[]
  types: string[]
  columnField: string
  doneField: string
  /** The raw state mapping of each column (work item type -> state), by column id. Not sent to the panel. */
  mappings: Map<string, Record<string, string>>
}

export function parseBoard(json: unknown): BoardInfo | null {
  const raw = json as {
    columns?: RawColumn[]
    fields?: Record<string, { referenceName?: unknown } | undefined>
  } | null
  if (!raw || !Array.isArray(raw.columns)) return null
  const columns: BoardColumn[] = []
  const types = new Set<string>()
  const byId = new Map<string, Record<string, string>>()
  for (const c of raw.columns) {
    if (typeof c?.name !== 'string') continue
    const mappings = c.stateMappings && typeof c.stateMappings === 'object' ? c.stateMappings : {}
    for (const key of Object.keys(mappings)) if (key) types.add(key)
    const id = typeof c.id === 'string' ? c.id : c.name
    const mapped: Record<string, string> = {}
    for (const [key, value] of Object.entries(mappings)) if (typeof value === 'string' && value) mapped[key] = value
    byId.set(id, mapped)
    columns.push({
      id,
      name: c.name,
      itemLimit: typeof c.itemLimit === 'number' && c.itemLimit > 0 ? c.itemLimit : 0,
      isSplit: !!c.isSplit,
      columnType: COLUMN_TYPES.find((t) => t === c.columnType) ?? ''
    })
  }
  const ref = (key: string) => {
    const name = raw.fields?.[key]?.referenceName
    return typeof name === 'string' ? name : ''
  }
  return { columns, types: [...types], columnField: ref('columnField'), doneField: ref('doneField'), mappings: byId }
}

type TeamField = { field: string; values: { value: string; includeChildren: boolean }[] }

function parseTeamField(json: unknown): TeamField | null {
  const raw = json as {
    field?: { referenceName?: unknown }
    values?: { value?: unknown; includeChildren?: unknown }[]
  } | null
  const field = raw?.field?.referenceName
  if (typeof field !== 'string' || !field) return null
  const values: TeamField['values'] = []
  for (const v of raw?.values ?? []) {
    if (typeof v?.value === 'string' && v.value) values.push({ value: v.value, includeChildren: v.includeChildren === true })
  }
  return { field, values }
}

/** The WIQL of the board: every item of the iteration, of the board's types, in the team's areas. */
export function buildBoardWiql(types: readonly string[], iterationPath: string, team: TeamField): string {
  const where = [
    '[System.TeamProject] = @project',
    `[System.WorkItemType] IN (${types.map(wiqlString).join(', ')})`,
    `[System.IterationPath] = ${wiqlString(iterationPath)}`
  ]
  const clauses = team.values.map((v) =>
    v.includeChildren
      ? `[${team.field}] UNDER ${wiqlString(v.value)}`
      : `[${team.field}] = ${wiqlString(v.value)}`
  )
  if (clauses.length > 0) where.push(`(${clauses.join(' OR ')})`)
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`
}

/**
 * The id of the PAT's owner. Not required: a failure only means no item reads as `mine`.
 * Called without an `api-version`.
 */
async function fetchMe(
  conn: Connection,
  fetchImpl: FetchLike,
  options: Options
): Promise<string | null> {
  const key = conn.organization.toLowerCase()
  const hit = options.meCache?.get(key)
  if (hit) return hit
  const answer = await request(
    fetchImpl,
    'GET',
    `${organizationUrl(conn.organization)}/_apis/connectionData`,
    undefined,
    conn.pat,
    options.signal
  )
  if (!answer.ok) {
    options.warn?.(`own identity unavailable: ${answer.error.kind}${answer.error.detail ? ` (${answer.error.detail})` : ''}`)
    return null
  }
  const id = (answer.json as { authenticatedUser?: { id?: unknown } })?.authenticatedUser?.id
  if (typeof id !== 'string' || !id) {
    options.warn?.('own identity unavailable: unexpected answer')
    return null
  }
  options.meCache?.set(key, id)
  return id
}

function fail(error: ListError): BoardResult {
  return { ok: false, error }
}

/** The chosen board's columns and every item of the team's current iteration on it. */
export async function getBoard(
  conn: Connection,
  ref: BoardRef | null,
  fetchImpl: FetchLike,
  options: Options = {}
): Promise<BoardResult> {
  if (!ref) return fail({ kind: 'boardNotConfigured' })
  const fetchedAt = (options.now ?? Date.now)()
  const { pat } = conn
  const teamBase = `${organizationUrl(conn.organization)}/${seg(ref.projectId)}/${seg(ref.teamId)}/_apis`
  const get = (url: string) => request(fetchImpl, 'GET', url, undefined, pat, options.signal)

  const [boardAnswer, iterationAnswer, fieldAnswer, me] = await Promise.all([
    get(`${teamBase}/work/boards/${seg(ref.boardId)}?api-version=${API_VERSION}`),
    get(`${teamBase}/work/teamsettings/iterations?$timeframe=current&api-version=${API_VERSION}`),
    get(`${teamBase}/work/teamsettings/teamfieldvalues?api-version=${API_VERSION}`),
    fetchMe(conn, fetchImpl, options)
  ])
  if (!boardAnswer.ok) return fail(boardAnswer.error)
  if (!iterationAnswer.ok) return fail(iterationAnswer.error)
  if (!fieldAnswer.ok) return fail(fieldAnswer.error)

  const board = parseBoard(boardAnswer.json)
  if (!board) return fail({ kind: 'server', detail: 'unexpected board answer' })
  const iterations = (iterationAnswer.json as { value?: { name?: unknown; path?: unknown }[] })?.value ?? []
  const current = iterations.find((i) => typeof i?.path === 'string' && i.path)
  if (!current) return fail({ kind: 'noCurrentIteration' })
  const iteration = {
    name: typeof current.name === 'string' ? current.name : '',
    path: current.path as string
  }
  const team = parseTeamField(fieldAnswer.json)
  if (!team) return fail({ kind: 'server', detail: 'unexpected team field answer' })

  const done = (items: BoardItem[], truncated: boolean): BoardResult => ({
    ok: true,
    board: ref,
    iteration,
    columns: board.columns,
    items,
    truncated,
    fetchedAt
  })
  // A board without work item types has nothing to ask for (and `IN ()` is not valid WIQL).
  if (board.types.length === 0) return done([], false)

  const wiql = await request(
    fetchImpl,
    'POST',
    `${teamBase}/wit/wiql?$top=${MAX_ITEMS}&api-version=${API_VERSION}`,
    { query: buildBoardWiql(board.types, iteration.path, team) },
    pat,
    options.signal
  )
  if (!wiql.ok) return fail(wiql.error)
  const ids = ((wiql.json as { workItems?: { id?: unknown }[] })?.workItems ?? [])
    .map((r) => r.id)
    .filter((id): id is number => typeof id === 'number')
    .slice(0, MAX_ITEMS)
  if (ids.length === 0) return done([], false)
  const truncated = ids.length >= MAX_ITEMS

  const fields = [...new Set([...FIELDS, 'System.AssignedTo', board.columnField, board.doneField])].filter(Boolean)
  const batch = await request(
    fetchImpl,
    'POST',
    `${organizationUrl(conn.organization)}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`,
    { ids, fields, errorPolicy: 'omit' },
    pat,
    options.signal
  )
  if (!batch.ok) return fail(batch.error)
  const raws = (batch.json as { value?: RawItem[] })?.value ?? []

  const names = [
    ...new Set(
      raws
        .map((r) => r?.fields?.['System.TeamProject'])
        .filter((n): n is string => typeof n === 'string' && n !== '')
    )
  ]
  const [metas, links] = await Promise.all([
    Promise.all(names.map((name) => projectTypes(conn, name, fetchImpl, options))),
    fetchLinks(conn, ids, fetchImpl, options)
  ])
  const byProject = new Map(names.map((name, index) => [name, metas[index]]))

  const order = new Map(ids.map((id, index) => [id, index]))
  const meId = me?.toLowerCase() ?? null
  const items: BoardItem[] = []
  for (const raw of raws) {
    const base = toItem(raw, conn, byProject.get(String(raw?.fields?.['System.TeamProject'] ?? '')))
    if (!base || base.stateCategory === 'Removed') continue
    const f = raw?.fields ?? {}
    const column = board.columnField ? f[board.columnField] : undefined
    const assignee = f['System.AssignedTo']
    const identity = assignee && typeof assignee === 'object' ? (assignee as { displayName?: unknown; id?: unknown }) : null
    const id = typeof identity?.id === 'string' ? identity.id.toLowerCase() : ''
    items.push({
      ...base,
      ...links.get(base.id),
      boardColumn: typeof column === 'string' ? column : '',
      boardColumnDone: board.doneField ? f[board.doneField] === true : false,
      assignedTo:
        typeof identity?.displayName === 'string'
          ? identity.displayName
          : typeof assignee === 'string'
            ? assignee
            : '',
      mine: meId !== null && id !== '' && id === meId
    })
  }
  items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return done(items, truncated)
}
