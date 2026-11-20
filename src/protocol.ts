// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/**
 * Azure DevOps state categories, in board order. '' when the worker could not read the work item
 * type's metadata (the list still works, only grouping order and icons degrade).
 */
export type StateCategory = 'Proposed' | 'InProgress' | 'Resolved' | 'Completed' | 'Removed' | ''

/** A work item as the panel shows it. */
export type WorkItem = {
  id: number
  /** The title to show: without the leading `[<area path segment>]` when that setting is on. */
  title: string
  /** Work item type name, such as `Bug` or `User Story`. */
  type: string
  /** Azure DevOps icon id of the type, such as `icon_insect`; '' when unknown. */
  typeIcon: string
  state: string
  stateCategory: StateCategory
  /** The column on the board of the team that owns the item's area; '' when it is on no board. */
  boardColumn: string
  /** In a split column, whether the item is in its Done half (false in the Doing half or unsplit). */
  boardColumnDone: boolean
  /** Child work items (hierarchy links) not removed, and how many of them are completed. */
  childrenTotal: number
  childrenDone: number
  /** Linked GitHub pull requests. */
  pullRequests: number
  /** The states of the item's type, in the type's order, for "Move to"; [] when unknown. */
  states: string[]
  project: string
  /** The page that opens the item in Azure DevOps. */
  url: string
}

export type GroupBy = 'none' | 'state' | 'boardColumn'

/** The team board the Board view shows, chosen in the config screen. */
export type BoardRef = {
  projectId: string
  projectName: string
  teamId: string
  teamName: string
  /** The board's id and name, such as `Stories`, `Features` or `Epics` (one per backlog level). */
  boardId: string
  boardName: string
}

export type Team = { id: string; name: string }
export type BoardSummary = { id: string; name: string }

/** A column of the team board, in board order. */
export type BoardColumn = {
  id: string
  name: string
  /** WIP limit; 0 when the column has none (incoming and outgoing columns never have one). */
  itemLimit: number
  /** Split into Doing and Done halves. */
  isSplit: boolean
  columnType: 'incoming' | 'inProgress' | 'outgoing' | ''
}

/**
 * A work item on the team board. `boardColumn` and `boardColumnDone` are read from this board's
 * own column fields, so they are exact for it.
 */
export type BoardItem = WorkItem & {
  /** Display name of the assignee; '' when unassigned. */
  assignedTo: string
  /** Assigned to the PAT's owner. */
  mine: boolean
}

export type BoardResult =
  | {
      ok: true
      board: BoardRef
      /** The team's current iteration; the board shows only its items. */
      iteration: { name: string; path: string }
      columns: BoardColumn[]
      items: BoardItem[]
      /** More items matched than the plugin reads (it reads at most 200). */
      truncated: boolean
      fetchedAt: number
    }
  | { ok: false; error: ListError }

/** Where "Move to" sends an item. */
export type MoveTarget =
  /** Another state of the item's type (Assigned to me). */
  | { kind: 'state'; state: string }
  /** A column of the chosen team board, and for a split column its Done half (Board). */
  | { kind: 'column'; columnId: string; done: boolean }

export type MoveResult = { ok: true } | { ok: false; error: ListError }

/** An agent already running in an Orca terminal, that "Start work" can send the prompt to. */
export type OpenAgent = {
  terminalId: string
  /** The agent CLI, such as `claude` or `codex`; '' when Orca does not know it. */
  agent: string
  /** The terminal's title, when it has one. */
  title: string
  workspaceId: string
  workspaceName: string
  /** The Orca project of the agent's workspace; '' for a workspace outside any project. */
  projectName: string
  state: 'working' | 'blocked' | 'waiting' | 'done'
}

/** A Git project of Orca, where "Start work" can create a new worktree. */
export type OrcaProject = { id: string; name: string; hostId: string }

/** Why an Orca call failed: the plugin lacks a capability the person has not approved, or Orca refused. */
export type OrcaError = { kind: 'capability' | 'orca'; detail?: string }

export type StartOptionsResult =
  | {
      ok: true
      agents: OpenAgent[]
      projects: OrcaProject[]
      /** The Orca project last used for this item's Azure DevOps project; '' when none yet. */
      lastProjectId: string
      /** The prompt to propose, built from the item (and its description and acceptance criteria). */
      prompt: string
      /** A worktree name to propose, such as `wi-123-fix-login`. */
      workspaceName: string
      /**
       * The agent kinds to offer for a new worktree, such as `claude`, `codex` or `kiro`: the ones
       * open now and in Orca's agent session history, most recent first (a short default list when
       * none is known).
       */
      agentKinds: string[]
      /** The agent last used for a new worktree from this plugin; '' when none yet. */
      lastAgent: string
    }
  | { ok: false; error: ListError | OrcaError }

/** Where "Start work" sends the prompt. */
export type StartTarget =
  /** An agent already running: the prompt is typed into its terminal and sent. */
  | { kind: 'agent'; terminalId: string }
  /** A new worktree in an Orca Git project, with a new agent of that kind that gets the prompt. */
  | { kind: 'worktree'; projectId: string; hostId: string; name: string; agent: string }

export type StartResult = { ok: true } | { ok: false; error: ListError | OrcaError }

export type TeamsResult = { ok: true; teams: Team[] } | { ok: false; error: ListError }
export type BoardsResult = { ok: true; boards: BoardSummary[] } | { ok: false; error: ListError }

/** `id` is the project's GUID; it equals `name` when only the name is known (fallback list). */
export type Project = { id: string; name: string }

/** Why a request failed. The panel turns each kind into its own message. */
export type ErrorKind =
  /** No organization or no PAT yet. */
  | 'notConfigured'
  /** Not an Azure DevOps organization name or URL. */
  | 'invalidOrganization'
  /** Orca cannot encrypt secrets on this machine (no OS keyring), so the PAT cannot be saved. */
  | 'secretsUnavailable'
  /** The PAT was refused: wrong, expired, revoked or for another organization. */
  | 'auth'
  /** The PAT works but lacks a scope (403). */
  | 'scope'
  /** The organization or project does not exist (404). */
  | 'notFound'
  /** The certificate is not trusted by Node (usually a proxy that inspects HTTPS). */
  | 'tls'
  /** No answer: DNS, connection refused, timeout or proxy. */
  | 'network'
  /** Any other answer the plugin did not expect. */
  | 'server'
  /** The Board view has no team board chosen yet. */
  | 'boardNotConfigured'
  /** The chosen team has no current iteration (none covers today's date). */
  | 'noCurrentIteration'
  /** Moving needs the PAT's Work Items (Read & write) scope, which it lacks (401/403 on a write). */
  | 'writeScope'
  /** Azure DevOps refused the change: a state transition or a rule of the process (400). */
  | 'rule'

export type ListError = { kind: ErrorKind; detail?: string }

export type ListResult =
  | { ok: true; items: WorkItem[]; fetchedAt: number }
  | { ok: false; error: ListError }

export type ProjectsResult =
  /**
   * `complete: false`: the PAT lacks Project and Team (Read), so the list holds only the projects
   * of the items assigned to the person (ids equal names).
   */
  | { ok: true; projects: Project[]; complete: boolean }
  | { ok: false; error: ListError }

export type ConfigView = {
  /** The organization name, as in https://dev.azure.com/<organization>. */
  organization: string
  /** Whether a PAT is stored for this organization. The PAT itself never leaves the worker. */
  hasPat: boolean
  protection: 'os-keyring' | 'unavailable'
  /** true: every project, including ones created later. false: only `projects`. */
  allProjects: boolean
  /** The chosen projects; meaningful only when `allProjects` is false. */
  projects: Project[]
  groupBy: GroupBy
  /** Remove a leading `[<area path segment>]` from titles. */
  stripAreaPrefix: boolean
  /** States left out of the list (Orca's Settings only); here so the panel knows when to reload. */
  hiddenStates: string[]
  /** Minutes between automatic reloads while the panel is visible; 0 is off. */
  refreshMinutes: number
  /** The team board of the Board view; null until chosen. */
  board: BoardRef | null
}

export type Prefs = Partial<
  Pick<
    ConfigView,
    'allProjects' | 'projects' | 'groupBy' | 'stripAreaPrefix' | 'refreshMinutes' | 'board'
  >
>

declare module 'orca' {
  interface PluginRequests {
    /** The current settings, preferences and whether a PAT is stored. */
    'config.get': { output: ConfigView }
    /** Tests the connection and saves the organization (and the PAT, when given) only if it works. */
    'config.save': {
      input: { organization: string; pat?: string }
      output: ListResult
    }
    /** Removes the stored PAT. */
    'pat.clear': { output: ConfigView }
    /** The projects the person can pick from. */
    'projects.list': { output: ProjectsResult }
    /** Saves the given preferences at once and answers the new view. */
    'prefs.set': { input: Prefs; output: ConfigView }
    /** The work items assigned to the PAT's owner, in the chosen projects, not in a hidden state. */
    'items.list': { output: ListResult }
    /** The teams of a project, for the board picker. */
    'teams.list': { input: { projectId: string }; output: TeamsResult }
    /** The boards of a team (one per backlog level), for the board picker. */
    'boards.list': { input: { projectId: string; teamId: string }; output: BoardsResult }
    /** The chosen team board: its columns and every item of the current iteration on it. */
    'board.get': { output: BoardResult }
    /**
     * Moves a work item: to a state, or to a column of the chosen board (which also sets the
     * state that column maps the item's type to). Needs Work Items (Read & write).
     */
    'item.move': { input: { id: number; target: MoveTarget }; output: MoveResult }
    /**
     * What "Start work" offers for an item: the open agents, the Orca Git projects, and a prompt
     * and worktree name to propose, in the panel's language (`locale`, such as `pt-BR`). Reads the
     * item's description, acceptance criteria and repro steps.
     */
    'start.options': { input: { id: number; locale: string }; output: StartOptionsResult }
    /**
     * Sends the prompt to an open agent, or creates a worktree with a new agent that gets it, then
     * shows that terminal or workspace. Remembers the Orca project per Azure project, and the agent.
     */
    'start.run': { input: { id: number; project: string; prompt: string; target: StartTarget }; output: StartResult }
  }
  interface PluginPanelEvents {
    /** The settings, preferences or stored PAT changed (here or in Orca's Settings). */
    'config.changed': ConfigView
  }
}
