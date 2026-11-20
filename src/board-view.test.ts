import { assert, test } from 'orca/testing'
import { columnTitle, defaultBoard, layoutBoard, sortBoards, startsFolded } from './board-view'
import type { BoardColumn, BoardItem } from './protocol'

const col = (name: string, over: Partial<BoardColumn> = {}): BoardColumn => ({
  id: name,
  name,
  itemLimit: 0,
  isSplit: false,
  columnType: 'inProgress',
  ...over
})
const it = (id: number, boardColumn: string, boardColumnDone = false): BoardItem => ({
  id,
  title: `T${id}`,
  type: 'Bug',
  typeIcon: '',
  state: 'Active',
  stateCategory: 'InProgress',
  boardColumn,
  boardColumnDone,
  childrenTotal: 0,
  childrenDone: 0,
  pullRequests: 0,
  states: [],
  project: 'Web',
  url: '',
  assignedTo: '',
  mine: false
})

test('layoutBoard keeps the column order, splits halves and collects strays', () => {
  const columns = [col('New', { columnType: 'incoming' }), col('Doing', { isSplit: true, itemLimit: 3 }), col('Done', { columnType: 'outgoing' })]
  const layout = layoutBoard(columns, [it(1, 'Doing', true), it(2, 'New'), it(3, 'Doing'), it(4, 'Gone'), it(5, 'Done')])
  assert.deepEqual(layout.columns.map((c) => c.items.map((i) => i.id)), [[2], [1, 3], [5]])
  assert.deepEqual(layout.columns[1]!.doing.map((i) => i.id), [3])
  assert.deepEqual(layout.columns[1]!.done.map((i) => i.id), [1])
  assert.deepEqual(layout.columns[0]!.doing, [])
  assert.deepEqual(layout.other.map((i) => i.id), [4])
})

test('columnTitle shows the WIP limit only when there is one', () => {
  assert.equal(columnTitle(col('Doing', { itemLimit: 4 }), 2), 'Doing · 2/4')
  assert.equal(columnTitle(col('New'), 0), 'New · 0')
})

test('only outgoing columns start folded', () => {
  assert.equal(startsFolded(col('Done', { columnType: 'outgoing' })), true)
  assert.equal(startsFolded(col('New', { columnType: 'incoming' })), false)
})

test('sortBoards puts Epics, Features, Stories first; defaultBoard prefers Stories', () => {
  const boards = [{ name: 'Zeta' }, { name: 'stories' }, { name: 'Alpha' }, { name: 'Epics' }, { name: 'Features' }]
  assert.deepEqual(sortBoards(boards).map((b) => b.name), ['Epics', 'Features', 'stories', 'Alpha', 'Zeta'])
  assert.equal(defaultBoard(boards)?.name, 'stories')
  assert.equal(defaultBoard([{ name: 'Zeta' }, { name: 'Alpha' }])?.name, 'Alpha')
  assert.equal(defaultBoard([]), null)
})
