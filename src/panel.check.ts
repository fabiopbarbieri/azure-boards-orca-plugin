// `orca plugin check` renders the panel once per scenario. Each scenario answers the panel's
// plugin.request itself, so check never reaches Azure DevOps.
import { defineCheck } from 'orca/testing'
import type { BoardColumn, BoardItem, BoardRef, BoardResult, ConfigView, ListResult, StateCategory, WorkItem } from './protocol'

const URL_ = 'https://dev.azure.com/contoso'
const configured: ConfigView = {
  organization: 'contoso',
  hasPat: true,
  protection: 'os-keyring',
  allProjects: true,
  projects: [],
  groupBy: 'none',
  stripAreaPrefix: true,
  hideClosed: 'off',
  hideAssigned: false,
  hiddenStates: ['Closed', 'Done', 'Removed'],
  refreshMinutes: 5,
  boards: []
}
const blank: ConfigView = { ...configured, organization: '', hasPat: false }

const item = (
  id: number,
  title: string,
  type: string,
  typeIcon: string,
  state: string,
  stateCategory: StateCategory,
  boardColumn: string,
  project: string
): WorkItem => ({
  id,
  title,
  type,
  typeIcon,
  state,
  stateCategory,
  boardColumn,
  boardColumnDone: false,
  childrenTotal: 0,
  childrenDone: 0,
  pullRequests: 0,
  states: ['New', 'Active', 'Resolved', 'Closed'],
  project,
  url: `${URL_}/${encodeURIComponent(project)}/_workitems/edit/${id}`
})

const list: ListResult = {
  ok: true,
  fetchedAt: Date.now() - 60_000,
  items: [
    item(4812, 'Login fails after password reset', 'Bug', 'icon_insect', 'Active', 'InProgress', 'Doing', 'Web'),
    item(4790, 'Export the monthly report as CSV', 'User Story', 'icon_book', 'New', 'Proposed', 'Backlog', 'Reports'),
    item(4766, 'Update the TLS certificate on staging', 'Task', 'icon_clipboard', 'In Progress', 'InProgress', 'Doing', 'Infra'),
    item(4750, 'Review the pagination design', 'Task', 'icon_clipboard', 'Resolved', 'Resolved', 'Review', 'Web'),
    item(4701, 'Quarterly billing epic', 'Epic', 'icon_crown', 'New', 'Proposed', '', 'Reports'),
    item(4655, 'Fix the flaky export test', 'Bug', 'icon_insect', 'Closed', 'Completed', 'Done', 'Web')
  ]
}

const boardRef: BoardRef = {
  projectId: 'p-web',
  projectName: 'Web',
  teamId: 't-core',
  teamName: 'Core',
  boardId: 'b-stories',
  boardName: 'Stories'
}
const col = (name: string, over: Partial<BoardColumn> = {}): BoardColumn => ({
  id: name,
  name,
  itemLimit: 0,
  isSplit: false,
  columnType: 'inProgress',
  ...over
})
const card = (id: number, title: string, boardColumn: string, assignedTo: string, mine = false, done = false): BoardItem => ({
  ...item(id, title, 'User Story', 'icon_book', 'Active', 'InProgress', boardColumn, 'Web'),
  boardColumnDone: done,
  assignedTo,
  mine
})
const board: BoardResult = {
  ok: true,
  board: boardRef,
  iteration: { name: 'Sprint 7', path: 'Web\\Sprint 7' },
  fetchedAt: Date.now() - 60_000,
  truncated: false,
  columns: [
    col('Backlog', { columnType: 'incoming' }),
    col('In Progress', { isSplit: true, itemLimit: 7 }),
    col('Code Review', { isSplit: true }),
    col('Deploy'),
    col('Closed', { columnType: 'outgoing' })
  ],
  items: [
    card(5001, 'Export the monthly report', 'Backlog', ''),
    card(5002, 'Login fails after password reset', 'In Progress', 'Rui Costa', true),
    card(5003, 'Update the TLS certificate', 'In Progress', 'Ana Souza', false, true),
    card(5004, 'Review the pagination design', 'Code Review', 'Ana Souza'),
    card(5005, 'Quarterly billing epic', 'Closed', 'Rui Costa', true)
  ]
}
const withBoard: ConfigView = { ...configured, boards: [boardRef] }
// Two teams named Core in different projects: their tabs carry the project too.
const sameName: BoardRef = { ...boardRef, projectId: 'p-api', projectName: 'API', teamId: 't-core-api' }
const ops: BoardRef = { ...boardRef, projectId: 'p-infra', projectName: 'Infra', teamId: 't-ops', teamName: 'Ops' }
const withBoards: ConfigView = { ...configured, boards: [boardRef, sameName, ops] }

const projects = ['Web', 'Reports', 'Infra'].map((name) => ({ id: name, name }))

export default defineCheck({
  boardTab: {
    requests: {
      'config.get': withBoard,
      'items.list': list,
      'board.get': board,
      'boards.list': {
        ok: true,
        boards: [
          { id: 'b-stories', name: 'Stories' },
          { id: 'b-features', name: 'Features' },
          { id: 'b-epics', name: 'Epics' }
        ]
      }
    },
    // The single Board tab of 0.2.0 opens the first registered board.
    persisted: { plugin: { activeTab: 'board' } }
  },
  severalBoards: {
    requests: {
      'config.get': withBoards,
      'items.list': list,
      'board.get': board,
      'boards.list': { ok: true, boards: [{ id: 'b-stories', name: 'Stories' }] }
    },
    persisted: { plugin: { activeTab: 'board-t-core' } }
  },
  boardsOnly: {
    requests: {
      'config.get': { ...withBoards, hideAssigned: true },
      'board.get': board,
      'boards.list': { ok: true, boards: [{ id: 'b-stories', name: 'Stories' }] }
    }
  },
  boardNotConfigured: {
    requests: {
      'config.get': configured,
      'items.list': list
    },
    persisted: { plugin: { activeTab: 'board' } }
  },
  boardNoIteration: {
    requests: {
      'config.get': withBoard,
      'items.list': list,
      'board.get': { ok: false, error: { kind: 'noCurrentIteration' } }
    },
    persisted: { plugin: { activeTab: 'board-t-core' } }
  },
  setup: { requests: { 'config.get': blank } },
  noKeyring: { requests: { 'config.get': { ...blank, protection: 'unavailable' } } },
  config: {
    requests: {
      'config.get': { ...configured, allProjects: false, projects: [projects[0]] },
      // check cannot press: a worker that answers notConfigured opens the config screen of a connected setup.
      'items.list': { ok: false, error: { kind: 'notConfigured' } },
      'projects.list': { ok: true, projects, complete: false }
    }
  },
  listByState: { requests: { 'config.get': { ...configured, groupBy: 'state' }, 'items.list': list } },
  listByBoardColumn: { requests: { 'config.get': { ...configured, groupBy: 'boardColumn' }, 'items.list': list } },
  list: { requests: { 'config.get': configured, 'items.list': list } },
  empty: { requests: { 'config.get': configured, 'items.list': { ...list, items: [] } } },
  patRefused: {
    requests: {
      'config.get': configured,
      'items.list': { ok: false, error: { kind: 'auth', detail: 'HTTP 401' } }
    }
  },
  untrustedCertificate: {
    requests: {
      'config.get': configured,
      'items.list': { ok: false, error: { kind: 'tls', detail: 'SELF_SIGNED_CERT_IN_CHAIN' } }
    }
  }
})
