// The children of a work item, for the panel's expandable rows. Pure like azure.ts: it takes
// `fetch` as an argument and never touches Orca.
import {
  API_VERSION,
  childIdsOf,
  chunks,
  FIELDS,
  fetchLinks,
  MAX_ITEMS,
  organizationUrl,
  projectTypes,
  request,
  toItem,
  type Connection,
  type FetchLike,
  type RawItem
} from './azure'
import { fetchMe, type Options } from './board'
import type { BoardItem, ChildrenResult, StateCategory } from './protocol'

const CATEGORY_ORDER: readonly StateCategory[] = ['Proposed', 'InProgress', 'Resolved', 'Completed', '']

function rank(category: StateCategory): number {
  const index = CATEGORY_ORDER.indexOf(category)
  return index === -1 ? CATEGORY_ORDER.length : index
}

/** The children of an item, not removed, by state category and then id, each with its own counters. */
export async function listChildren(
  conn: Connection,
  id: number,
  fetchImpl: FetchLike,
  options: Options = {}
): Promise<ChildrenResult> {
  const url = `${organizationUrl(conn.organization)}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`
  const post = (body: unknown) => request(fetchImpl, 'POST', url, body, conn.pat, options.signal)

  const relations = await post({ ids: [id], $expand: 'relations', errorPolicy: 'omit' })
  if (!relations.ok) return { ok: false, error: relations.error }
  const parent = (relations.json as { value?: ({ relations?: unknown } | null)[] })?.value?.[0]
  const kids = childIdsOf(parent?.relations)
  if (kids.length === 0) return { ok: true, items: [] }

  const fields = [...FIELDS, 'System.AssignedTo']
  const [answers, me] = await Promise.all([
    Promise.all(chunks(kids, MAX_ITEMS).map((part) => post({ ids: part, fields, errorPolicy: 'omit' }))),
    fetchMe(conn, fetchImpl, options)
  ])
  const raws: RawItem[] = []
  for (const answer of answers) {
    if (!answer.ok) return { ok: false, error: answer.error }
    raws.push(...((answer.json as { value?: RawItem[] })?.value ?? []))
  }

  const names = [
    ...new Set(
      raws
        .map((r) => r?.fields?.['System.TeamProject'])
        .filter((n): n is string => typeof n === 'string' && n !== '')
    )
  ]
  const metas = await Promise.all(names.map((name) => projectTypes(conn, name, fetchImpl, options)))
  const byProject = new Map(names.map((name, index) => [name, metas[index]]))

  const meId = me?.toLowerCase() ?? null
  const found: BoardItem[] = []
  for (const raw of raws) {
    const base = toItem(raw, conn, byProject.get(String(raw?.fields?.['System.TeamProject'] ?? '')))
    // A child the batch omitted (no access, deleted) is simply not in `raws`.
    if (!base || base.stateCategory === 'Removed') continue
    const assignee = raw?.fields?.['System.AssignedTo']
    const identity = assignee && typeof assignee === 'object' ? (assignee as { displayName?: unknown; id?: unknown }) : null
    const identityId = typeof identity?.id === 'string' ? identity.id.toLowerCase() : ''
    found.push({
      ...base,
      assignedTo:
        typeof identity?.displayName === 'string'
          ? identity.displayName
          : typeof assignee === 'string'
            ? assignee
            : '',
      mine: meId !== null && identityId !== '' && identityId === meId
    })
  }

  const links = await fetchLinks(conn, found.map((item) => item.id), fetchImpl, options)
  const items = found
    .map((item) => ({ ...item, ...links.get(item.id) }))
    .sort((a, b) => rank(a.stateCategory) - rank(b.stateCategory) || a.id - b.id)
  return { ok: true, items }
}
