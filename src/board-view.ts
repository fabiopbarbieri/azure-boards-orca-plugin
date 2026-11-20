// Arranges the items of a team board into its columns (and Doing/Done halves). Pure, so it is unit tested.
import type { BoardColumn, BoardItem } from './protocol'

export type ColumnSection = {
  column: BoardColumn
  /** Every item of the column, in incoming order. */
  items: BoardItem[]
  /** Split columns only: the items of each half. Both are empty for an unsplit column. */
  doing: BoardItem[]
  done: BoardItem[]
}

export type BoardLayout = {
  /** One section per column, in the board's order. */
  columns: ColumnSection[]
  /** Items whose column matches none of the board's columns. */
  other: BoardItem[]
}

/** Matches items to columns by name; the first column of a name wins. */
export function layoutBoard(columns: readonly BoardColumn[], items: readonly BoardItem[]): BoardLayout {
  const sections = columns.map((column): ColumnSection => ({ column, items: [], doing: [], done: [] }))
  const byName = new Map<string, ColumnSection>()
  for (const section of sections) if (!byName.has(section.column.name)) byName.set(section.column.name, section)
  const other: BoardItem[] = []
  for (const item of items) {
    const section = byName.get(item.boardColumn)
    if (!section) {
      other.push(item)
      continue
    }
    section.items.push(item)
    if (section.column.isSplit) (item.boardColumnDone ? section.done : section.doing).push(item)
  }
  return { columns: sections, other }
}

/** `Doing · 3`, or `Doing · 3/4` when the column has a WIP limit. */
export function columnTitle(column: BoardColumn, count: number): string {
  return column.itemLimit > 0 ? `${column.name} · ${count}/${column.itemLimit}` : `${column.name} · ${count}`
}

/** Outgoing (done) columns start folded; every other column starts open. */
export function startsFolded(column: BoardColumn): boolean {
  return column.columnType === 'outgoing'
}

const LEVELS = ['epics', 'features', 'stories']

/** Backlog levels first (Epics, Features, Stories), then any other board by name. */
export function sortBoards<T extends { name: string }>(boards: readonly T[]): T[] {
  const rank = (b: T): number => {
    const i = LEVELS.indexOf(b.name.trim().toLowerCase())
    return i === -1 ? LEVELS.length : i
  }
  return [...boards].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** The board a team gets when none is chosen: "Stories" (any case), else the first in order. */
export function defaultBoard<T extends { name: string }>(boards: readonly T[]): T | null {
  return boards.find((b) => b.name.trim().toLowerCase() === 'stories') ?? sortBoards(boards)[0] ?? null
}
