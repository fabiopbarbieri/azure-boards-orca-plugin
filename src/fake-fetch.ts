// Test helper: a fetch that answers from a script and records what it was asked. Only the tests
// import it.
import type { FetchLike } from './azure'

export type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }
export type Answer = Response | Error | ((call: Call) => Response | Error)

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

export function html(status: number, location?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
  if (location) headers.location = location
  return new Response('<html><body>Sign in</body></html>', { status, headers })
}

/** A rejected fetch the way undici reports it: a TypeError whose `cause` has the code. */
export function netError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
}

export function fakeFetch(...answers: Answer[]): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    }
    calls.push(call)
    const next = answers.shift()
    if (!next) throw new Error(`unexpected fetch ${url}`)
    const answer = typeof next === 'function' ? next(call) : next
    if (answer instanceof Error) throw answer
    return answer
  }
  return Object.assign(fn, { calls })
}

/**
 * A fetch that answers by URL instead of by order, for calls that run in parallel. A route matches
 * when its pattern (a string to find, or a RegExp) fits `METHOD url`; the first match wins. An
 * array of answers is used up in turn, the last one repeating. Anything unmatched throws.
 */
export type Route = [pattern: string | RegExp | ((call: Call) => boolean), answer: Answer | Answer[]]

export function routedFetch(...routes: Route[]): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  const fn = async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    }
    calls.push(call)
    const key = `${call.method} ${url}`
    const route = routes.find(([pattern]) =>
      typeof pattern === 'function'
        ? pattern(call)
        : typeof pattern === 'string'
          ? key.includes(pattern)
          : pattern.test(key)
    )
    if (!route) throw new Error(`unexpected fetch ${key}`)
    const [, answers] = route
    const next = Array.isArray(answers) ? (answers.length > 1 ? answers.shift()! : answers[0]!) : answers
    const answer = typeof next === 'function' ? next(call) : next
    if (answer instanceof Error) throw answer
    // A Response body is read once: hand out a copy so a repeating route can answer again.
    return answer.clone()
  }
  return Object.assign(fn, { calls })
}

export const FAKE_PAT = 'fake-pat-0123456789abcdefghijklmnopqrstuvwxyz'

export const wiql = (...ids: number[]) => json({ workItems: ids.map((id) => ({ id, url: `x/${id}` })) })

export type FakeItem = {
  id: number
  title: string
  project?: string
  type?: string
  state?: string
  area?: string
  column?: string
  columnDone?: boolean
  /** Extra fields, such as a custom board column or `System.AssignedTo`. */
  fields?: Record<string, unknown>
}

export const batch = (...items: FakeItem[]) =>
  json({
    count: items.length,
    value: items.map((i) => ({
      id: i.id,
      fields: {
        'System.Id': i.id,
        'System.Title': i.title,
        'System.WorkItemType': i.type ?? 'Task',
        'System.State': i.state ?? 'Active',
        'System.TeamProject': i.project ?? 'My Project',
        'System.AreaPath': i.area ?? i.project ?? 'My Project',
        ...(i.column === undefined ? {} : { 'System.BoardColumn': i.column }),
        ...(i.columnDone === undefined ? {} : { 'System.BoardColumnDone': i.columnDone }),
        ...(i.fields ?? {})
      }
    }))
  })

/** The answer of `_apis/wit/workitemtypes`: `[type name, icon id, [state, category][]]`. */
export const workItemTypes = (...types: [string, string, [string, string][]][]) =>
  json({
    count: types.length,
    value: types.map(([name, icon, states]) => ({
      name,
      icon: { id: icon, url: `https://icons/${icon}` },
      color: 'CC293D',
      states: states.map(([state, category]) => ({ name: state, color: '000000', category }))
    }))
  })

/** The answer of `_apis/projects`. */
export const projectsAnswer = (
  projects: { id: string; name: string; state?: string }[],
  continuation?: string
) => {
  const res = json({
    count: projects.length,
    value: projects.map((p) => ({ id: p.id, name: p.name, state: p.state ?? 'wellFormed' }))
  })
  if (continuation) res.headers.set('x-ms-continuationtoken', continuation)
  return res
}

/** The answer of `work/boards/{id}`: columns as `[name, type, itemLimit, isSplit, stateMappings]`. */
export const boardAnswer = (
  columns: [string, string, number, boolean, Record<string, string>][],
  fields = { column: 'WEF_1_Kanban.Column', done: 'WEF_1_Kanban.Column.Done', row: 'WEF_1_Kanban.Lane' }
) =>
  json({
    id: 'b1',
    name: 'Stories',
    columns: columns.map(([name, columnType, itemLimit, isSplit, stateMappings], index) => ({
      id: `c${index}`,
      name,
      columnType,
      itemLimit,
      isSplit,
      stateMappings,
      description: ''
    })),
    fields: {
      columnField: { referenceName: fields.column },
      doneField: { referenceName: fields.done },
      rowField: { referenceName: fields.row }
    }
  })

/** The answer of `teamsettings/iterations?$timeframe=current`. */
export const iterationsAnswer = (...iterations: { name: string; path: string }[]) =>
  json({ count: iterations.length, value: iterations.map((i, n) => ({ id: `i${n}`, ...i })) })

/** The answer of `teamsettings/teamfieldvalues`. */
export const teamFieldAnswer = (values: { value: string; includeChildren: boolean }[], field = 'System.AreaPath') =>
  json({ field: { referenceName: field }, defaultValue: values[0]?.value ?? '', values })

/** The answer of `_apis/connectionData`. */
export const connectionData = (id: string) => json({ authenticatedUser: { id, providerDisplayName: 'Me' } })

/** The answer of `projects/{id}/teams`. */
export const teamsAnswer = (...teams: { id: string; name: string }[]) => json({ count: teams.length, value: teams })

const batchBody = (call: Call) =>
  call.url.includes('/wit/workitemsbatch') ? (call.body as { $expand?: string; fields?: string[] }) : null

/** Matches the `workitemsbatch` call that asks for relations. */
export const isRelationsBatch = (call: Call) => batchBody(call)?.$expand === 'relations'
/** Matches the `workitemsbatch` call that asks for the fields of the items themselves. */
export const isFieldsBatch = (call: Call) => {
  const body = batchBody(call)
  return body !== null && body.$expand === undefined
}

/** The answer of a relations batch: `[id, [rel, url, attributes name?][]]`. */
export const relationsAnswer = (...items: [number, [string, string, string?][]][]) =>
  json({
    count: items.length,
    value: items.map(([id, rels]) => ({
      id,
      relations: rels.map(([rel, url, name]) => ({ rel, url, attributes: name ? { name } : {} }))
    }))
  })

export const child = (id: number) => ['System.LinkTypes.Hierarchy-Forward', `https://x/_apis/wit/workItems/${id}`] as [string, string]
export const pr = (n: number) =>
  ['ArtifactLink', `vstfs:///GitHub/PullRequest/repo%2F${n}`, 'GitHub Pull Request'] as [string, string, string]
