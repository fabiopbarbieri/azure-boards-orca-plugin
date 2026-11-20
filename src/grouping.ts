// Groups the list by state or board column and orders the groups. Pure, so it is unit tested.
import type { GroupBy, StateCategory, WorkItem } from './protocol'

export type Group = {
  /** The state or column name; '' is the group of items on no board column. */
  name: string
  items: WorkItem[]
}

const CATEGORY_ORDER: Record<StateCategory, number> = {
  Proposed: 0,
  InProgress: 1,
  Resolved: 2,
  Completed: 3,
  Removed: 4,
  '': 5
}

function rank(category: StateCategory): number {
  return CATEGORY_ORDER[category] ?? CATEGORY_ORDER['']
}

/**
 * `none` gives no groups. `state`: ordered by the state's category, then name. `boardColumn`:
 * ordered by the lowest category among the column's items, then name; items on no column go last.
 * Items keep their incoming order inside a group.
 */
export function groupItems(items: readonly WorkItem[], groupBy: GroupBy): Group[] {
  if (groupBy === 'none') return []
  const byName = new Map<string, { group: Group; rank: number }>()
  for (const item of items) {
    const name = groupBy === 'state' ? item.state : item.boardColumn
    let entry = byName.get(name)
    if (!entry) {
      entry = { group: { name, items: [] }, rank: Number.POSITIVE_INFINITY }
      byName.set(name, entry)
    }
    entry.group.items.push(item)
    entry.rank = Math.min(entry.rank, rank(item.stateCategory))
  }
  return [...byName.values()]
    .sort((a, b) => {
      const noColumn = groupBy === 'boardColumn' ? Number(a.group.name === '') - Number(b.group.name === '') : 0
      return noColumn || a.rank - b.rank || a.group.name.localeCompare(b.group.name)
    })
    .map((entry) => entry.group)
}
