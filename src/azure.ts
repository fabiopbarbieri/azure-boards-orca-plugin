// Azure DevOps Services (cloud) REST client for the worker. Pure: it takes `fetch` as an argument
// and never touches Orca, so the tests drive it with a fake fetch.
import type { ListError, ListResult, Project, ProjectsResult, StateCategory, WorkItem } from './protocol'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const HOST = 'https://dev.azure.com'
export const API_VERSION = '7.1'

/** WIQL returns at most this many ids, which is also the batch endpoint's limit. */
export const MAX_ITEMS = 200

const REQUEST_TIMEOUT_MS = 20_000

export const FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.TeamProject',
  'System.AreaPath',
  'System.BoardColumn',
  'System.BoardColumnDone'
]

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

/** Letters, digits and hyphens, starting with a letter or digit. */
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/

export type Connection = {
  /** A valid organization name. */
  organization: string
  pat: string
  /** Items in these states are left out. */
  hiddenStates: readonly string[]
  /** true: every project. false: only `projects`, and an empty list means no items at all. */
  allProjects: boolean
  /** Project names; read only when `allProjects` is false. */
  projects: readonly string[]
  /** Remove a leading `[<area path segment>]` from titles. */
  stripAreaPrefix: boolean
}

/** What the worker keeps between calls: the work item type metadata of each project. */
export type MetadataCache = Map<string, { at: number; types: Map<string, TypeInfo> | null }>

export type TypeInfo = { icon: string; states: Map<string, StateCategory> }

export type ListOptions = {
  signal?: AbortSignal
  now?: () => number
  cache?: MetadataCache
  /** Called once per project whose type metadata could not be read. Never gets the PAT. */
  warn?: (message: string) => void
}

export function createMetadataCache(): MetadataCache {
  return new Map()
}

/** Type metadata rarely changes; a failure is remembered shorter so a fixed scope shows up soon. */
const METADATA_TTL_MS = 60 * 60 * 1000
const METADATA_FAILURE_TTL_MS = 5 * 60 * 1000

/**
 * The organization name from what the person typed: `contoso`, `https://dev.azure.com/contoso/...`,
 * `dev.azure.com/contoso` or the older `https://contoso.visualstudio.com`. Null when it is none.
 */
export function parseOrganization(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (ORGANIZATION.test(text)) return text
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  let name: string | undefined
  if (host === 'dev.azure.com') name = decodeURIComponent(url.pathname.split('/')[1] ?? '')
  else if (host.endsWith('.visualstudio.com')) name = host.slice(0, -'.visualstudio.com'.length)
  return name && ORGANIZATION.test(name) ? name : null
}

/** `Closed, Done` -> ['Closed', 'Done']. */
export function parseStates(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Basic with an empty user name, as Azure DevOps documents for PATs. */
export function authorization(pat: string): string {
  return `Basic ${btoa(`:${pat}`)}`
}

export function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * `projects` null: every project. Always asked at the organization level, so one query covers all
 * the chosen projects.
 */
export function buildWiql(projects: readonly string[] | null, hiddenStates: readonly string[]): string {
  const where = ['[System.AssignedTo] = @Me']
  if (projects) where.push(`[System.TeamProject] IN (${projects.map(wiqlString).join(', ')})`)
  if (hiddenStates.length > 0) {
    where.push(`[System.State] NOT IN (${hiddenStates.map(wiqlString).join(', ')})`)
  }
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`
}

export function organizationUrl(organization: string): string {
  return `${HOST}/${encodeURIComponent(organization)}`
}

export function workItemUrl(organization: string, project: string, id: number): string {
  return `${organizationUrl(organization)}/${encodeURIComponent(project)}/_workitems/edit/${id}`
}

export type Outcome = { ok: true; json: unknown; headers: Headers } | { ok: false; error: ListError }

/** An outcome that also knows the HTTP status of a failure (absent when there was no answer). */
export type StatusOutcome = Outcome & { status?: number }

function serverMessage(text: string): string {
  try {
    const json = JSON.parse(text) as { message?: unknown }
    if (typeof json.message === 'string') return json.message
  } catch {
    // not JSON: fall through to the raw text
  }
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, pat: string): string {
  const safe = pat ? text.split(pat).join('***') : text
  return safe.length > 300 ? `${safe.slice(0, 297)}...` : safe
}

async function readOutcome(res: Response, pat: string): Promise<Outcome> {
  const status = res.status
  // A refused PAT comes back as 401, as a redirect to the sign-in page (kept by redirect: manual;
  // an opaque redirect reads as status 0), or as 203 with that page's HTML.
  if (status === 0 || status === 401 || status === 203 || (status >= 300 && status < 400)) {
    return { ok: false, error: { kind: 'auth', detail: `HTTP ${status}` } }
  }
  if (status === 403 || status === 404) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      error: { kind: status === 403 ? 'scope' : 'notFound', detail: clip(serverMessage(text), pat) }
    }
  }
  if (status >= 200 && status < 300) {
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('json')) {
      // An HTML sign-in page with 200: the server did not accept the credentials.
      return { ok: false, error: { kind: 'auth', detail: `HTTP ${status} ${type}`.trim() } }
    }
    try {
      return { ok: true, json: await res.json(), headers: res.headers }
    } catch {
      return { ok: false, error: { kind: 'server', detail: `HTTP ${status}: invalid JSON` } }
    }
  }
  const message = clip(serverMessage(await res.text().catch(() => '')), pat)
  return {
    ok: false,
    error: { kind: 'server', detail: message ? `HTTP ${status}: ${message}` : `HTTP ${status}` }
  }
}

function networkError(error: unknown): ListError {
  const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string } }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return { kind: 'network', detail: 'timeout' }
  }
  const code = err?.cause?.code ?? err?.code
  if (code && TLS_CODES.has(code)) return { kind: 'tls', detail: code }
  return { kind: 'network', detail: code ?? err?.message ?? String(error) }
}

function timeoutSignal(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  if (!outer) return timeout
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return any ? any([outer, timeout]) : outer
}

export type Method = 'GET' | 'POST' | 'PATCH'

/** Like `request`, but a failure also carries the HTTP status, for callers that map it (a 400). */
export async function requestWithStatus(
  fetchImpl: FetchLike,
  method: Method,
  url: string,
  body: unknown,
  pat: string,
  signal?: AbortSignal
): Promise<StatusOutcome> {
  const headers: Record<string, string> = {
    Authorization: authorization(pat),
    Accept: 'application/json',
    // Asks for 401 instead of a redirect to the sign-in page.
    'X-TFS-FedAuthRedirect': 'Suppress'
  }
  if (method === 'POST') headers['Content-Type'] = 'application/json'
  if (method === 'PATCH') headers['Content-Type'] = 'application/json-patch+json'
  let res: Response
  try {
    res = await fetchImpl(url, {
      method,
      redirect: 'manual',
      signal: timeoutSignal(signal),
      headers,
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) })
    })
  } catch (error) {
    return { ok: false, error: networkError(error) }
  }
  const outcome = await readOutcome(res, pat)
  return outcome.ok ? outcome : { ...outcome, status: res.status }
}

export async function request(
  fetchImpl: FetchLike,
  method: Method,
  url: string,
  body: unknown,
  pat: string,
  signal?: AbortSignal
): Promise<Outcome> {
  const outcome = await requestWithStatus(fetchImpl, method, url, body, pat, signal)
  // The status stays inside the worker: what is returned to callers (and the panel) is unchanged.
  return outcome.ok ? outcome : { ok: false, error: outcome.error }
}

export type RawItem = { id?: number; fields?: Record<string, unknown> } | null

const CATEGORIES: readonly StateCategory[] = ['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed']

function category(value: unknown): StateCategory {
  return CATEGORIES.find((c) => c === value) ?? ''
}

/** Case, accents and spacing never decide whether a bracket names an area. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const LEADING_BRACKET = /^\s*\[([^\]]*)\]/
const LEADING_SEPARATOR = /^\s*[-–—:|]\s*/

/**
 * Removes the leading `[...]` prefixes that name a segment of the area path (the team usually
 * repeats its own name in the title), with the separator that follows. In a compound bracket such
 * as `[Area | 1234 | Service]` only the leading parts that name the area go: `[1234 | Service]`.
 * A bracket that does not start with an area segment (`[BUG]`) stays, and so does the original
 * title when nothing else would be left.
 */
export function cleanTitle(title: string, areaPath: string): string {
  const segments = new Set(
    areaPath
      .split('\\')
      .map(normalize)
      .filter(Boolean)
  )
  if (segments.size === 0) return title
  let rest = title
  for (;;) {
    const match = LEADING_BRACKET.exec(rest)
    if (!match) break
    const parts = match[1]!.split('|').map((part) => part.trim())
    let drop = 0
    while (drop < parts.length && segments.has(normalize(parts[drop]!))) drop++
    if (drop === 0) break
    const after = rest.slice(match[0].length)
    if (drop < parts.length) {
      // Keep what the bracket says besides the area, such as a ticket number.
      rest = `[${parts.slice(drop).join(' | ')}]${after}`
      break
    }
    rest = after.replace(LEADING_SEPARATOR, '').trimStart()
  }
  return rest.trim() ? rest : title
}

export function toItem(raw: RawItem, conn: Connection, meta: Map<string, TypeInfo> | null | undefined): WorkItem | null {
  if (!raw || typeof raw.id !== 'number') return null
  const f = raw.fields ?? {}
  const text = (key: string) => (typeof f[key] === 'string' ? (f[key] as string) : '')
  const project = text('System.TeamProject')
  const type = text('System.WorkItemType')
  const state = text('System.State')
  const info = meta?.get(type)
  const title = text('System.Title')
  return {
    id: raw.id,
    title: conn.stripAreaPrefix ? cleanTitle(title, text('System.AreaPath')) : title,
    type,
    typeIcon: info?.icon ?? '',
    state,
    stateCategory: info?.states.get(state) ?? '',
    boardColumn: text('System.BoardColumn'),
    boardColumnDone: f['System.BoardColumnDone'] === true,
    states: info ? [...info.states.keys()] : [],
    project,
    url: workItemUrl(conn.organization, project, raw.id),
    childrenTotal: 0,
    childrenDone: 0,
    pullRequests: 0
  }
}

type Raw = { ok: true; raw: RawItem[]; ids: number[] } | { ok: false; error: ListError }

/** Runs the WIQL query, then fetches the fields of up to MAX_ITEMS items in one batch. */
async function fetchRaw(
  conn: Connection,
  projects: readonly string[] | null,
  fields: readonly string[],
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<Raw> {
  const { organization, pat } = conn
  const base = organizationUrl(organization)
  const wiql = await request(
    fetchImpl,
    'POST',
    `${base}/_apis/wit/wiql?$top=${MAX_ITEMS}&api-version=${API_VERSION}`,
    { query: buildWiql(projects, conn.hiddenStates) },
    pat,
    signal
  )
  if (!wiql.ok) return wiql

  const refs = (wiql.json as { workItems?: { id?: unknown }[] })?.workItems ?? []
  const ids = refs
    .map((r) => r.id)
    .filter((id): id is number => typeof id === 'number')
    .slice(0, MAX_ITEMS)
  if (ids.length === 0) return { ok: true, raw: [], ids }

  const batch = await request(
    fetchImpl,
    'POST',
    `${base}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`,
    { ids, fields, errorPolicy: 'omit' },
    pat,
    signal
  )
  if (!batch.ok) return batch
  return { ok: true, raw: (batch.json as { value?: RawItem[] })?.value ?? [], ids }
}

function parseTypes(json: unknown): Map<string, TypeInfo> {
  const types = new Map<string, TypeInfo>()
  const value = (json as { value?: unknown })?.value
  if (!Array.isArray(value)) throw new Error('unexpected work item types answer')
  for (const t of value as {
    name?: unknown
    icon?: { id?: unknown }
    states?: { name?: unknown; category?: unknown }[]
  }[]) {
    if (typeof t?.name !== 'string') continue
    const states = new Map<string, StateCategory>()
    for (const s of t.states ?? []) if (typeof s?.name === 'string') states.set(s.name, category(s.category))
    types.set(t.name, { icon: typeof t.icon?.id === 'string' ? t.icon.id : '', states })
  }
  return types
}

/** The type metadata of a project: from the cache, or one GET. Null when it could not be read. */
export async function projectTypes(
  conn: Connection,
  project: string,
  fetchImpl: FetchLike,
  options: ListOptions
): Promise<Map<string, TypeInfo> | null> {
  const now = (options.now ?? Date.now)()
  const key = `${conn.organization.toLowerCase()}|${project}`
  const hit = options.cache?.get(key)
  if (hit && now - hit.at < (hit.types ? METADATA_TTL_MS : METADATA_FAILURE_TTL_MS)) return hit.types

  const answer = await request(
    fetchImpl,
    'GET',
    `${organizationUrl(conn.organization)}/${encodeURIComponent(project)}/_apis/wit/workitemtypes?api-version=${API_VERSION}`,
    undefined,
    conn.pat,
    options.signal
  )
  let types: Map<string, TypeInfo> | null = null
  let reason = ''
  if (answer.ok) {
    try {
      types = parseTypes(answer.json)
    } catch (error) {
      reason = (error as Error).message
    }
  } else {
    reason = `${answer.error.kind}${answer.error.detail ? ` (${answer.error.detail})` : ''}`
  }
  // An aborted list must not poison the cache with a failure it did not earn.
  if (options.signal?.aborted) return null
  options.cache?.set(key, { at: now, types })
  if (!types) options.warn?.(`type metadata of project "${project}" unavailable: ${reason}`)
  return types
}

export type Links = { childrenTotal: number; childrenDone: number; pullRequests: number }

const CHILD_LINK = 'System.LinkTypes.Hierarchy-Forward'
const PR_NAME = 'GitHub Pull Request'

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Children (and how many are done) and GitHub pull requests of each item, from its relations.
 * Never fails: when a call fails, it is logged once and the result is empty (every count reads 0).
 */
export async function fetchLinks(
  conn: Connection,
  ids: readonly number[],
  fetchImpl: FetchLike,
  options: ListOptions
): Promise<Map<number, Links>> {
  const out = new Map<number, Links>()
  if (ids.length === 0) return out
  const base = `${organizationUrl(conn.organization)}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`
  const post = (body: unknown) => request(fetchImpl, 'POST', base, body, conn.pat, options.signal)
  const degrade = (what: string, error: ListError) => {
    options.warn?.(`${what} unavailable: ${error.kind}${error.detail ? ` (${error.detail})` : ''}`)
    return new Map<number, Links>()
  }

  const answers = await Promise.all(
    chunks(ids, MAX_ITEMS).map((part) => post({ ids: part, $expand: 'relations', errorPolicy: 'omit' }))
  )
  const children = new Map<number, number[]>()
  const prs = new Map<number, number>()
  for (const answer of answers) {
    if (!answer.ok) return degrade('relations', answer.error)
    const value = (answer.json as { value?: ({ id?: unknown; relations?: unknown } | null)[] })?.value ?? []
    for (const item of value) {
      if (!item || typeof item.id !== 'number' || !Array.isArray(item.relations)) continue
      const kids: number[] = []
      const urls = new Set<string>()
      for (const rel of item.relations as { rel?: unknown; url?: unknown; attributes?: { name?: unknown } }[]) {
        if (typeof rel?.url !== 'string') continue
        if (rel.rel === CHILD_LINK) {
          const child = Number(rel.url.split('/').pop())
          if (Number.isInteger(child) && !kids.includes(child)) kids.push(child)
        } else if (rel.rel === 'ArtifactLink' && rel.attributes?.name === PR_NAME) urls.add(rel.url)
      }
      children.set(item.id, kids)
      prs.set(item.id, urls.size)
    }
  }

  const childIds = [...new Set([...children.values()].flat())]
  const states = new Map<number, { project: string; type: string; state: string }>()
  if (childIds.length > 0) {
    const batches = await Promise.all(
      chunks(childIds, MAX_ITEMS).map((part) =>
        post({ ids: part, fields: ['System.State', 'System.WorkItemType', 'System.TeamProject'], errorPolicy: 'omit' })
      )
    )
    for (const answer of batches) {
      if (!answer.ok) return degrade('children', answer.error)
      for (const raw of (answer.json as { value?: RawItem[] })?.value ?? []) {
        if (!raw || typeof raw.id !== 'number') continue
        const f = raw.fields ?? {}
        const text = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '')
        states.set(raw.id, { project: text('System.TeamProject'), type: text('System.WorkItemType'), state: text('System.State') })
      }
    }
  }
  const projects = [...new Set([...states.values()].map((s) => s.project).filter(Boolean))]
  const metas = await Promise.all(projects.map((name) => projectTypes(conn, name, fetchImpl, options)))
  const byProject = new Map(projects.map((name, index) => [name, metas[index]]))

  for (const [id, kids] of children) {
    let total = 0
    let done = 0
    for (const kid of kids) {
      const child = states.get(kid)
      // A child the batch omitted (no access, deleted) is not counted.
      if (!child) continue
      const cat = byProject.get(child.project)?.get(child.type)?.states.get(child.state) ?? ''
      if (cat === 'Removed') continue
      total++
      if (cat === 'Completed') done++
    }
    out.set(id, { childrenTotal: total, childrenDone: done, pullRequests: prs.get(id) ?? 0 })
  }
  return out
}

/** The assigned items, in the query's order, with icons and state categories when they can be read. */
export async function listAssigned(
  conn: Connection,
  fetchImpl: FetchLike,
  options: ListOptions = {}
): Promise<ListResult> {
  const fetchedAt = (options.now ?? Date.now)()
  if (!conn.allProjects && conn.projects.length === 0) return { ok: true, items: [], fetchedAt }

  const result = await fetchRaw(conn, conn.allProjects ? null : conn.projects, FIELDS, fetchImpl, options.signal)
  if (!result.ok) return { ok: false, error: result.error }

  const projects = new Set<string>()
  for (const raw of result.raw) {
    const name = raw?.fields?.['System.TeamProject']
    if (typeof name === 'string' && name) projects.add(name)
  }
  const names = [...projects]
  const [metas, links] = await Promise.all([
    Promise.all(names.map((name) => projectTypes(conn, name, fetchImpl, options))),
    fetchLinks(conn, result.ids, fetchImpl, options)
  ])
  const byProject = new Map(names.map((name, index) => [name, metas[index]]))

  const order = new Map(result.ids.map((id, index) => [id, index]))
  const items = result.raw
    .map((raw) => toItem(raw, conn, byProject.get(String(raw?.fields?.['System.TeamProject'] ?? ''))))
    .filter((item): item is WorkItem => item !== null)
    .map((item) => ({ ...item, ...links.get(item.id) }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return { ok: true, items, fetchedAt }
}

const MAX_PROJECT_PAGES = 5

/**
 * The projects of the organization. When the PAT lacks Project and Team (Read), falls back to the
 * projects of the items assigned to the person (`complete: false`, ids equal names).
 */
export async function listProjects(
  conn: Connection,
  fetchImpl: FetchLike,
  options: { signal?: AbortSignal } = {}
): Promise<ProjectsResult> {
  const base = `${organizationUrl(conn.organization)}/_apis/projects?api-version=${API_VERSION}&$top=500`
  const projects: Project[] = []
  let token: string | null = null
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const url: string = token ? `${base}&continuationToken=${encodeURIComponent(token)}` : base
    const answer = await request(fetchImpl, 'GET', url, undefined, conn.pat, options.signal)
    if (!answer.ok) {
      // Azure DevOps may answer 401 for a missing scope, so a refused PAT lands here too; the
      // fallback's own query then reports the real error.
      const { kind } = answer.error
      if (page === 0 && (kind === 'auth' || kind === 'scope')) return projectsFromItems(conn, fetchImpl, options.signal)
      return { ok: false, error: answer.error }
    }
    const value = (answer.json as { value?: { id?: unknown; name?: unknown; state?: unknown }[] })?.value ?? []
    for (const p of value) {
      if (typeof p?.name !== 'string' || !p.name) continue
      if (typeof p.state === 'string' && p.state.toLowerCase() !== 'wellformed') continue
      projects.push({ id: typeof p.id === 'string' && p.id ? p.id : p.name, name: p.name })
    }
    token = answer.headers.get('x-ms-continuationtoken')
    if (!token) break
  }
  projects.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, projects, complete: true }
}

async function projectsFromItems(
  conn: Connection,
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<ProjectsResult> {
  const result = await fetchRaw(conn, null, ['System.TeamProject'], fetchImpl, signal)
  if (!result.ok) return result
  const names = new Set<string>()
  for (const raw of result.raw) {
    const name = raw?.fields?.['System.TeamProject']
    if (typeof name === 'string' && name) names.add(name)
  }
  const projects = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: name, name }))
  return { ok: true, projects, complete: false }
}
