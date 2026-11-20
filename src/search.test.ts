import { assert, test } from 'orca/testing'
import { filterItems, matchesQuery } from './search'

const item = { id: 18123, title: 'Ajustar integração de Login' }

test('an empty or blank query matches everything', () => {
  assert.ok(matchesQuery(item, ''))
  assert.ok(matchesQuery(item, '   '))
})

test('finds by number, with or without #, anywhere in it', () => {
  assert.ok(matchesQuery(item, '18123'))
  assert.ok(matchesQuery(item, '#18123'))
  assert.ok(matchesQuery(item, '812'))
  assert.ok(!matchesQuery(item, '#999'))
})

test('finds a piece of the title, ignoring case and accents', () => {
  assert.ok(matchesQuery(item, 'integracao'))
  assert.ok(matchesQuery(item, 'LOGIN'))
  assert.ok(matchesQuery(item, '  de log '))
  assert.ok(!matchesQuery(item, 'logout'))
})

test('filterItems keeps the order and returns a copy when there is no query', () => {
  const items = [
    { id: 1, title: 'Alpha' },
    { id: 2, title: 'Beta' },
    { id: 3, title: 'Alphabet' }
  ]
  assert.deepEqual(filterItems(items, 'alpha').map((i) => i.id), [1, 3])
  const all = filterItems(items, '')
  assert.deepEqual(all, items)
  assert.ok(all !== items)
})
