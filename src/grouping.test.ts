import { assert, test } from 'orca/testing'
import { groupItems } from './grouping'
import type { StateCategory, WorkItem } from './protocol'

const item = (id: number, state: string, stateCategory: StateCategory, boardColumn = ''): WorkItem => ({
  id,
  title: `Item ${id}`,
  type: 'Task',
  typeIcon: 'icon_clipboard',
  state,
  stateCategory,
  boardColumn,
  boardColumnDone: false,
  childrenTotal: 0,
  childrenDone: 0,
  pullRequests: 0,
  states: [],
  project: 'Web',
  url: `https://dev.azure.com/contoso/Web/_workitems/edit/${id}`
})

const names = (groups: { name: string }[]) => groups.map((g) => g.name)

test('none makes no groups', () => {
  assert.deepEqual(groupItems([item(1, 'New', 'Proposed')], 'none'), [])
})

test('state groups follow the category order, then the name', () => {
  const groups = groupItems(
    [
      item(1, 'Closed', 'Completed'),
      item(2, 'Zeta', 'InProgress'),
      item(3, 'New', 'Proposed'),
      item(4, 'Alpha', 'InProgress'),
      item(5, 'Odd', ''),
      item(6, 'Removed', 'Removed'),
      item(7, 'Resolved', 'Resolved')
    ],
    'state'
  )
  assert.deepEqual(names(groups), ['New', 'Alpha', 'Zeta', 'Resolved', 'Closed', 'Removed', 'Odd'])
})

test('items keep their incoming order inside a group', () => {
  const groups = groupItems([item(3, 'Active', 'InProgress'), item(1, 'Active', 'InProgress'), item(2, 'Active', 'InProgress')], 'state')
  assert.deepEqual(groups[0].items.map((i) => i.id), [3, 1, 2])
})

test('board columns are ordered by their lowest category, with no column last', () => {
  const groups = groupItems(
    [
      item(1, 'Active', 'InProgress', 'Doing'),
      item(2, 'Closed', 'Completed', 'Done'),
      item(3, 'New', 'Proposed', ''),
      item(4, 'New', 'Proposed', 'Backlog'),
      item(5, 'Closed', 'Completed', 'Doing'),
      item(6, 'Active', 'InProgress', 'Review')
    ],
    'boardColumn'
  )
  assert.deepEqual(names(groups), ['Backlog', 'Doing', 'Review', 'Done', ''])
  assert.deepEqual(groups[1].items.map((i) => i.id), [1, 5])
})

test('a column with an unknown category sorts after the known ones, before no column', () => {
  const groups = groupItems([item(1, 'X', '', 'Mystery'), item(2, 'Y', '', ''), item(3, 'Z', 'Completed', 'Done')], 'boardColumn')
  assert.deepEqual(names(groups), ['Done', 'Mystery', ''])
})
