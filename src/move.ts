// Moving a work item: to a state, or to a column of a registered board. Pure like azure.ts: it takes
// `fetch` as an argument and never touches Orca.
import {
  API_VERSION,
  organizationUrl,
  request,
  requestWithStatus,
  type Connection,
  type FetchLike
} from './azure'
import { parseBoard } from './board'
import type { BoardRef, ListError, MoveResult, MoveTarget } from './protocol'

type Op = { op: 'add'; path: string; value: string | boolean }

/** A well-formed request, or null: `id` a positive integer and a complete target. */
export function parseMove(input: unknown): { id: number; target: MoveTarget } | null {
  const raw = input as {
    id?: unknown
    target?: { kind?: unknown; state?: unknown; teamId?: unknown; columnId?: unknown; done?: unknown }
  } | null
  if (!raw || typeof raw.id !== 'number' || !Number.isInteger(raw.id) || raw.id <= 0) return null
  const t = raw.target
  if (!t || typeof t !== 'object') return null
  if (t.kind === 'state') {
    return typeof t.state === 'string' && t.state.trim() ? { id: raw.id, target: { kind: 'state', state: t.state } } : null
  }
  if (t.kind === 'column') {
    return typeof t.teamId === 'string' && t.teamId && typeof t.columnId === 'string' && t.columnId && typeof t.done === 'boolean'
      ? { id: raw.id, target: { kind: 'column', teamId: t.teamId, columnId: t.columnId, done: t.done } }
      : null
  }
  return null
}

/**
 * Applies the JSON Patch. A refused PAT or missing scope reads as `writeScope`; a 400 is a rule of
 * the process (the server's message, already redacted, is the detail). Other failures keep the usual mapping.
 */
async function patch(
  conn: Connection,
  id: number,
  ops: Op[],
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<MoveResult> {
  const url = `${organizationUrl(conn.organization)}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`
  const answer = await requestWithStatus(fetchImpl, 'PATCH', url, ops, conn.pat, signal)
  if (answer.ok) return { ok: true }
  const { error } = answer
  if (error.kind === 'auth' || error.kind === 'scope') return fail({ ...error, kind: 'writeScope' })
  if (answer.status === 400) {
    return fail({ kind: 'rule', detail: (error.detail ?? '').replace(/^HTTP 400:? ?/, '') })
  }
  return fail(error)
}

function fail(error: ListError): MoveResult {
  return { ok: false, error }
}

/** Moves the item. `ref` is the registered board of the target's team, needed only for a column target. */
export async function moveItem(
  conn: Connection,
  ref: BoardRef | null,
  id: number,
  target: MoveTarget,
  fetchImpl: FetchLike,
  options: { signal?: AbortSignal } = {}
): Promise<MoveResult> {
  const { signal } = options
  if (target.kind === 'state') {
    return patch(conn, id, [{ op: 'add', path: '/fields/System.State', value: target.state }], fetchImpl, signal)
  }
  if (!ref) return fail({ kind: 'boardNotConfigured' })

  const org = organizationUrl(conn.organization)
  const seg = encodeURIComponent
  const [boardAnswer, typeAnswer] = await Promise.all([
    request(
      fetchImpl,
      'GET',
      `${org}/${seg(ref.projectId)}/${seg(ref.teamId)}/_apis/work/boards/${seg(ref.boardId)}?api-version=${API_VERSION}`,
      undefined,
      conn.pat,
      signal
    ),
    request(
      fetchImpl,
      'GET',
      `${org}/_apis/wit/workitems/${id}?fields=System.WorkItemType&api-version=${API_VERSION}`,
      undefined,
      conn.pat,
      signal
    )
  ])
  if (!boardAnswer.ok) return fail(boardAnswer.error)
  if (!typeAnswer.ok) return fail(typeAnswer.error)

  const board = parseBoard(boardAnswer.json)
  if (!board || !board.columnField) return fail({ kind: 'server', detail: 'unexpected board answer' })
  const column = board.columns.find((c) => c.id === target.columnId)
  if (!column) return fail({ kind: 'server', detail: 'unknown column' })
  const type = (typeAnswer.json as { fields?: Record<string, unknown> } | null)?.fields?.['System.WorkItemType']
  if (typeof type !== 'string' || !type) return fail({ kind: 'server', detail: 'unexpected work item answer' })
  const state = board.mappings.get(column.id)?.[type]
  if (!state) return fail({ kind: 'rule', detail: 'the column does not accept this work item type' })

  const ops: Op[] = [{ op: 'add', path: `/fields/${board.columnField}`, value: column.name }]
  if (board.doneField) {
    ops.push({ op: 'add', path: `/fields/${board.doneField}`, value: column.isSplit ? target.done : false })
  }
  ops.push({ op: 'add', path: '/fields/System.State', value: state })
  return patch(conn, id, ops, fetchImpl, signal)
}
