// Maps an Azure DevOps work item type to an Orca icon. Pure, so it is unit tested.
import type { IconName } from 'orca'

/** By the icon id Azure DevOps gives the type (`icon_insect`), the most exact signal. */
const BY_ICON: Record<string, IconName> = {
  icon_insect: 'bug',
  icon_clipboard: 'check',
  icon_book: 'book',
  icon_list: 'file-text',
  icon_trophy: 'star',
  icon_crown: 'zap',
  icon_check_box: 'check',
  icon_flame: 'warning',
  icon_chat_bubble: 'info',
  icon_review: 'search',
  icon_test_beaker: 'activity',
  icon_test_plan: 'activity',
  icon_test_suite: 'activity',
  icon_test_case: 'activity',
  icon_test_step: 'activity',
  icon_test_parameter: 'activity',
  icon_sticky_note: 'file-text',
  icon_traffic_cone: 'warning',
  icon_car: 'star',
  icon_airplane: 'star',
  icon_gift: 'star',
  icon_diamond: 'star',
  icon_star: 'star',
  icon_gavel: 'hammer',
  icon_palette: 'lightbulb',
  icon_key: 'plug'
}

/** By type name, for custom types or when the icon id is unknown. */
const BY_NAME: Record<string, IconName> = {
  bug: 'bug',
  task: 'check',
  'user story': 'book',
  'product backlog item': 'book',
  requirement: 'book',
  feature: 'star',
  epic: 'zap',
  issue: 'warning',
  impediment: 'warning'
}

export function iconFor(typeIcon: string, typeName: string): IconName {
  const byIcon = BY_ICON[typeIcon.trim().toLowerCase()]
  if (byIcon) return byIcon
  const name = typeName.trim().toLowerCase()
  const byName = BY_NAME[name]
  if (byName) return byName
  if (name.startsWith('test')) return 'activity'
  return 'blocks'
}

