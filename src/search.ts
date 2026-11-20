// The search box of both tabs: finds items by number or by a piece of the title. Pure, so it is unit tested.

/** Lowercase without accents, so "operacoes" finds "Operações". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Whether the item matches what the person typed: its number (`123` or `#123`, anywhere in the
 * number) or a piece of its title, ignoring case and accents. An empty query matches everything.
 */
export function matchesQuery(item: { id: number; title: string }, query: string): boolean {
  const q = fold(query.trim())
  if (!q) return true
  return fold(`#${item.id} ${item.title}`).includes(q)
}

/** The items that match, in their order; the same list when the query is empty. */
export function filterItems<T extends { id: number; title: string }>(items: readonly T[], query: string): T[] {
  return query.trim() ? items.filter((item) => matchesQuery(item, query)) : [...items]
}
