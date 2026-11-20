import { assert, test } from 'orca/testing'
import { iconFor } from './icons'

test('the Azure DevOps icon id wins', () => {
  assert.equal(iconFor('icon_insect', 'Whatever'), 'bug')
  assert.equal(iconFor('icon_book', 'Task'), 'book')
  assert.equal(iconFor('icon_crown', ''), 'zap')
  assert.equal(iconFor('icon_test_case', ''), 'activity')
  assert.equal(iconFor('icon_gavel', ''), 'hammer')
})

test('falls back to the type name, ignoring case', () => {
  assert.equal(iconFor('', 'Bug'), 'bug')
  assert.equal(iconFor('icon_unknown', 'TASK'), 'check')
  assert.equal(iconFor('', 'User Story'), 'book')
  assert.equal(iconFor('', 'Product Backlog Item'), 'book')
  assert.equal(iconFor('', 'Requirement'), 'book')
  assert.equal(iconFor('', 'Feature'), 'star')
  assert.equal(iconFor('', 'Epic'), 'zap')
  assert.equal(iconFor('', 'Impediment'), 'warning')
  assert.equal(iconFor('', 'Test Case'), 'activity')
})

test('falls back to blocks', () => {
  assert.equal(iconFor('', ''), 'blocks')
  assert.equal(iconFor('icon_nope', 'Custom thing'), 'blocks')
})
