// Azure Boards panel. No network here: every Azure DevOps call goes through the worker with
// plugin.request. Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Box,
  Button,
  Callout,
  Checkbox,
  Code,
  Collapsible,
  EmptyState,
  env,
  Field,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Select,
  set,
  shell,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Switch,
  Text,
  Textarea,
  Toolbar,
  update,
  type OrcaNode,
  type PanelContext,
  type ReadonlyAtom
} from 'orca'
import { columnTitle, defaultBoard, layoutBoard, sortBoards, startsFolded, type ColumnSection } from './board-view'
import { groupItems } from './grouping'
import { filterItems } from './search'
import { iconFor } from './icons'
import type {
  BoardItem,
  BoardRef,
  BoardResult,
  BoardColumn,
  BoardSummary,
  ChildrenResult,
  ConfigView,
  ErrorKind,
  GroupBy,
  HideClosed,
  ListError,
  ListResult,
  MoveResult,
  MoveTarget,
  OpenAgent,
  OrcaError,
  OrcaProject,
  Prefs,
  Project,
  StartOptionsResult,
  StartResult,
  StartTarget,
  Team,
  WorkItem
} from './protocol'

// ---------------------------------------------------------------------------------------------
// Text: Orca's UI language, English or Brazilian Portuguese.

type Messages = {
  loading: string
  connectTitle: string
  settingsTitle: string
  connectIntro: string
  connectionSection: string
  orgLabel: string
  orgHelp: string
  patLabel: string
  patHelp: string
  patStoredLabel: string
  changeConnectionHelp: string
  connect: string
  connecting: string
  forgetPat: string
  projectsSection: string
  allProjects: string
  loadingProjects: string
  projectsIncomplete: string
  searchProjects: string
  projectList: string
  selectedCount: (n: number) => string
  noneSelected: string
  displaySection: string
  prefixRemoved: string
  prefixKept: string
  refreshSection: string
  hideClosedLabel: string
  hideClosedOptions: Record<HideClosed, string>
  /** The Display section's summary of the setting; '' when off. */
  hideClosedSummary: Record<HideClosed, string>
  closedHidden: (count: number) => string
  stripPrefix: string
  stripPrefixHelp: string
  refreshLabel: string
  refreshOptions: Record<number, string>
  save: string
  saving: string
  back: string
  assigned: string
  refresh: string
  settings: string
  groupBy: string
  groupOptions: Record<GroupBy, string>
  noColumn: string
  emptyTitle: string
  emptyBody: string
  tabsLabel: string
  tabAssigned: (n: number | null) => string
  tabBoard: string
  loadingBoard: string
  boardNotConfiguredTitle: string
  boardNotConfiguredBody: string
  chooseBoard: string
  boardSection: string
  boardNotChosen: string
  noBoardsYet: string
  addBoard: string
  removeBoard: (team: string) => string
  allTeamsAdded: string
  projectLabel: string
  teamLabel: string
  boardLabel: string
  boardLevel: string
  choose: string
  loadingTeams: string
  loadingBoards: string
  teamsScope: string
  noTeams: string
  noBoards: string
  doing: string
  done: string
  emptyHalf: string
  noItems: string
  search: string
  searchLabel: string
  searchPlaceholder: string
  noMatches: string
  other: string
  truncated: string
  tasks: (done: number, total: number) => string
  pullRequests: (n: number) => string
  tryAgain: string
  openFailed: string
  openInBrowser: string
  moveTo: string
  closeItem: string
  showChildren: string
  hideChildren: string
  loadingChildren: string
  noChildren: string
  childrenList: string
  moving: string
  startWork: string
  preparing: string
  sending: string
  sendTo: string
  newWorktree: string
  startProject: string
  worktreeName: string
  startAgent: string
  promptLabel: string
  send: string
  cancel: string
  noGitProject: string
  agentFallback: string
  capabilityTitle: string
  capabilityBody: string
  orcaRefused: string
  sentToAgent: (agent: string, workspace: string) => string
  sentWorktree: (name: string, agent: string) => string
  saveFailed: string
  errors: Record<ErrorKind, { title: string; body: string }>
}

const EN: Messages = {
  loading: 'Loading work items',
  connectTitle: 'Connect to Azure Boards',
  settingsTitle: 'Settings',
  connectIntro: 'Lists the work items assigned to you in Azure DevOps (dev.azure.com).',
  connectionSection: 'Connection',
  orgLabel: 'Organization',
  orgHelp: 'The name in https://dev.azure.com/<organization>. You can paste the URL.',
  patLabel: 'Personal access token',
  patHelp:
    'Create it scoped to this organization, with Work Items (Read) and Project and Team (Read). Orca stores it encrypted; it is sent only to dev.azure.com.',
  patStoredLabel: 'PAT stored',
  changeConnectionHelp: 'To change the organization or the PAT, delete the stored PAT.',
  connect: 'Connect',
  connecting: 'Connecting',
  forgetPat: 'Forget PAT',
  projectsSection: 'Projects',
  allProjects: 'All projects',
  loadingProjects: 'Loading projects',
  projectsIncomplete:
    'Only projects with items assigned to you are listed. Add the Project and Team (Read) scope to the PAT to see all of them.',
  searchProjects: 'Search projects',
  projectList: 'Projects',
  selectedCount: (n) => `${n} selected`,
  noneSelected: 'No project selected: the list will be empty.',
  displaySection: 'Display',
  prefixRemoved: 'Area prefix removed',
  prefixKept: 'Full titles',
  refreshSection: 'Refresh',
  hideClosedLabel: 'Hide completed items',
  hideClosedOptions: { off: 'Off', children: 'In child lists only', all: 'Everywhere' },
  hideClosedSummary: { off: '', children: 'completed hidden in child lists', all: 'completed hidden' },
  closedHidden: (count) => (count === 1 ? '1 completed item hidden.' : `${count} completed items hidden.`),
  stripPrefix: 'Remove the area prefix from titles',
  stripPrefixHelp: '“[Web Team] Fix login” shows as “Fix login”.',
  refreshLabel: 'Refresh every',
  refreshOptions: { 0: 'Off', 5: '5 minutes', 15: '15 minutes', 30: '30 minutes' },
  save: 'Save',
  saving: 'Saving',
  back: 'Back',
  assigned: 'Assigned to me',
  refresh: 'Refresh',
  settings: 'Settings',
  groupBy: 'Group by',
  groupOptions: { none: 'No grouping', state: 'State', boardColumn: 'Board column' },
  noColumn: 'No column',
  emptyTitle: 'Nothing assigned',
  emptyBody: 'No open work items are assigned to you.',
  tabsLabel: 'View',
  tabAssigned: (n) => (n === null ? 'Assigned to me' : `Assigned to me · ${n}`),
  tabBoard: 'Board',
  loadingBoard: 'Loading board',
  boardNotConfiguredTitle: 'Add a team board',
  boardNotConfiguredBody: 'Each board you add gets its own tab with every item of the team’s current iteration.',
  chooseBoard: 'Add board',
  boardSection: 'Boards',
  boardNotChosen: 'None',
  noBoardsYet: 'No boards yet. Pick a project and a team, then press Add.',
  addBoard: 'Add',
  removeBoard: (team) => `Remove ${team}`,
  allTeamsAdded: 'Every team of this project is already added.',
  projectLabel: 'Project',
  teamLabel: 'Team',
  boardLabel: 'Board',
  boardLevel: 'Board level',
  choose: 'Choose',
  loadingTeams: 'Loading teams',
  loadingBoards: 'Loading boards',
  teamsScope: 'The PAT needs the Project and Team (Read) scope to list teams and boards.',
  noTeams: 'This project has no teams.',
  noBoards: 'This team has no boards.',
  doing: 'Doing',
  done: 'Done',
  emptyHalf: '—',
  noItems: 'No items',
  search: 'Search',
  searchLabel: 'Search by number or title',
  searchPlaceholder: 'Number or title',
  noMatches: 'No item matches the search.',
  other: 'Other',
  truncated: 'Showing the first 200 items',
  tasks: (done, total) => `📋 ${done}/${total}`,
  pullRequests: (n) => (n === 1 ? '1 PR' : `${n} PRs`),
  tryAgain: 'Try again',
  openFailed: 'Orca could not open the browser.',
  openInBrowser: 'Open in browser',
  moveTo: 'Move to',
  closeItem: 'Close',
  showChildren: 'Show child items',
  hideChildren: 'Hide child items',
  loadingChildren: 'Loading child items',
  noChildren: 'No child items.',
  childrenList: 'Child items',
  moving: 'Moving',
  startWork: 'Start work',
  preparing: 'Preparing…',
  sending: 'Sending…',
  sendTo: 'Send to',
  newWorktree: 'New worktree',
  startProject: 'Project',
  worktreeName: 'Worktree name',
  startAgent: 'Agent',
  promptLabel: 'Prompt',
  send: 'Send',
  cancel: 'Cancel',
  noGitProject: 'No Git project in Orca.',
  agentFallback: 'agent',
  capabilityTitle: 'Orca has not allowed this yet',
  capabilityBody:
    'Start work needs the plugin to see and control Orca’s workspaces and agents. Approve the plugin’s new permissions in Settings → Plugins.',
  orcaRefused: 'Orca refused',
  sentToAgent: (agent, workspace) => `Sent to ${agent} · ${workspace}`,
  sentWorktree: (name, agent) => `Worktree ${name} created with ${agent}`,
  saveFailed: 'The settings were not saved.',
  errors: {
    notConfigured: { title: 'Not connected', body: 'Enter the organization and a PAT for it.' },
    invalidOrganization: {
      title: 'Invalid organization',
      body: 'Use the organization name, such as contoso, or its URL, such as https://dev.azure.com/contoso.'
    },
    secretsUnavailable: {
      title: 'The PAT cannot be stored safely',
      body: 'Orca has no OS keyring to encrypt secrets on this machine (on Linux it fell back to basic_text). Install and unlock a keyring such as GNOME Keyring or KWallet, then restart Orca.'
    },
    auth: {
      title: 'PAT refused',
      body: 'Azure DevOps did not accept the PAT: it may be wrong, expired, revoked or for another organization. Create a new one for this organization with the Work Items (Read) scope.'
    },
    scope: { title: 'Missing permission', body: 'The PAT works but lacks the Work Items (Read) scope.' },
    notFound: { title: 'Not found', body: 'Check the organization and the project name.' },
    tls: {
      title: 'Certificate not trusted',
      body: 'The dev.azure.com certificate was not trusted, usually because a network proxy inspects HTTPS. Start Orca with NODE_EXTRA_CA_CERTS pointing to that proxy’s CA file.'
    },
    network: { title: 'No connection', body: 'The server did not answer. Check the URL, the network, VPN or proxy.' },
    server: { title: 'Unexpected answer', body: 'Azure DevOps answered with an error.' },
    writeScope: {
      title: 'The PAT can’t change work items',
      body: 'Create a PAT for this organization with the Work Items (Read & write) scope, delete the stored PAT under Connection in the settings and connect with the new one.'
    },
    rule: {
      title: 'Azure DevOps refused the change',
      body: 'The state transition or a rule of the process does not allow it. The server’s message follows.'
    },
    boardNotConfigured: { title: 'No board added', body: 'Add a team board in the settings.' },
    noCurrentIteration: {
      title: 'No current iteration',
      body: 'The team has no iteration that covers today. Check its iterations in Azure DevOps.'
    }
  }
}

const PT: Messages = {
  loading: 'Carregando work items',
  connectTitle: 'Conectar ao Azure Boards',
  settingsTitle: 'Configurações',
  connectIntro: 'Lista os work items atribuídos a você no Azure DevOps (dev.azure.com).',
  connectionSection: 'Conexão',
  orgLabel: 'Organização',
  orgHelp: 'O nome em https://dev.azure.com/<organização>. Pode colar a URL.',
  patLabel: 'Personal access token (PAT)',
  patHelp:
    'Crie escopado a esta organização, com Work Items (Read) e Project and Team (Read). O Orca guarda o PAT criptografado; ele só é enviado ao dev.azure.com.',
  patStoredLabel: 'PAT guardado',
  changeConnectionHelp: 'Para trocar a organização ou o PAT, apague o PAT guardado.',
  connect: 'Conectar',
  connecting: 'Conectando',
  forgetPat: 'Esquecer PAT',
  projectsSection: 'Projetos',
  allProjects: 'Todos os projetos',
  loadingProjects: 'Carregando projetos',
  projectsIncomplete:
    'Só aparecem os projetos com itens atribuídos a você. Adicione o escopo Project and Team (Read) ao PAT para ver todos.',
  searchProjects: 'Buscar projetos',
  projectList: 'Projetos',
  selectedCount: (n) => (n === 1 ? '1 selecionado' : `${n} selecionados`),
  noneSelected: 'Nenhum projeto selecionado: a lista ficará vazia.',
  displaySection: 'Exibição',
  prefixRemoved: 'Prefixo da área removido',
  prefixKept: 'Títulos completos',
  refreshSection: 'Atualização',
  hideClosedLabel: 'Ocultar concluídos',
  hideClosedOptions: { off: 'Desligado', children: 'Só nas listas de filhos', all: 'Em tudo' },
  hideClosedSummary: { off: '', children: 'concluídos ocultos nos filhos', all: 'concluídos ocultos' },
  closedHidden: (count) => (count === 1 ? '1 item concluído oculto.' : `${count} itens concluídos ocultos.`),
  stripPrefix: 'Remover o prefixo da área dos títulos',
  stripPrefixHelp: '“[Time Web] Ajustar login” aparece como “Ajustar login”.',
  refreshLabel: 'Atualizar a cada',
  refreshOptions: { 0: 'Desligado', 5: '5 minutos', 15: '15 minutos', 30: '30 minutos' },
  save: 'Salvar',
  saving: 'Salvando',
  back: 'Voltar',
  assigned: 'Atribuídos a mim',
  refresh: 'Atualizar',
  settings: 'Configurações',
  groupBy: 'Agrupar por',
  groupOptions: { none: 'Sem agrupamento', state: 'Estado', boardColumn: 'Coluna do board' },
  noColumn: 'Sem coluna',
  emptyTitle: 'Nada atribuído',
  emptyBody: 'Nenhum work item aberto está atribuído a você.',
  tabsLabel: 'Visão',
  tabAssigned: (n) => (n === null ? 'Atribuídos a mim' : `Atribuídos a mim · ${n}`),
  tabBoard: 'Board',
  loadingBoard: 'Carregando board',
  boardNotConfiguredTitle: 'Adicione o board de um time',
  boardNotConfiguredBody: 'Cada board adicionado ganha uma aba com todos os itens da iteração atual do time.',
  chooseBoard: 'Adicionar board',
  boardSection: 'Boards',
  boardNotChosen: 'Nenhum',
  noBoardsYet: 'Nenhum board ainda. Escolha um projeto e um time e clique em Adicionar.',
  addBoard: 'Adicionar',
  removeBoard: (team) => `Remover ${team}`,
  allTeamsAdded: 'Todos os times deste projeto já foram adicionados.',
  projectLabel: 'Projeto',
  teamLabel: 'Time',
  boardLabel: 'Board',
  boardLevel: 'Nível do board',
  choose: 'Escolher',
  loadingTeams: 'Carregando times',
  loadingBoards: 'Carregando boards',
  teamsScope: 'O PAT precisa do escopo Project and Team (Read) para listar times e boards.',
  noTeams: 'Este projeto não tem times.',
  noBoards: 'Este time não tem boards.',
  doing: 'Em andamento',
  done: 'Concluído',
  emptyHalf: '—',
  noItems: 'Nenhum item',
  search: 'Buscar',
  searchLabel: 'Buscar por número ou título',
  searchPlaceholder: 'Número ou título',
  noMatches: 'Nenhum item corresponde à busca.',
  other: 'Outros',
  truncated: 'Mostrando os primeiros 200 itens',
  tasks: (done, total) => `📋 ${done}/${total}`,
  pullRequests: (n) => (n === 1 ? '1 PR' : `${n} PRs`),
  tryAgain: 'Tentar de novo',
  openFailed: 'O Orca não conseguiu abrir o navegador.',
  openInBrowser: 'Abrir no navegador',
  moveTo: 'Mover para',
  closeItem: 'Fechar',
  showChildren: 'Mostrar itens filhos',
  hideChildren: 'Ocultar itens filhos',
  loadingChildren: 'Carregando itens filhos',
  noChildren: 'Nenhum item filho.',
  childrenList: 'Itens filhos',
  moving: 'Movendo',
  startWork: 'Iniciar trabalho',
  preparing: 'Preparando…',
  sending: 'Enviando…',
  sendTo: 'Enviar para',
  newWorktree: 'Novo worktree',
  startProject: 'Projeto',
  worktreeName: 'Nome do worktree',
  startAgent: 'Agente',
  promptLabel: 'Prompt',
  send: 'Enviar',
  cancel: 'Cancelar',
  noGitProject: 'Nenhum projeto Git no Orca.',
  agentFallback: 'agente',
  capabilityTitle: 'O Orca ainda não permitiu isso',
  capabilityBody:
    'Iniciar trabalho precisa que o plugin veja e controle os workspaces e agentes do Orca. Aprove as novas permissões do plugin em Configurações → Plugins.',
  orcaRefused: 'O Orca recusou',
  sentToAgent: (agent, workspace) => `Enviado para ${agent} · ${workspace}`,
  sentWorktree: (name, agent) => `Worktree ${name} criado com ${agent}`,
  saveFailed: 'As configurações não foram salvas.',
  errors: {
    notConfigured: { title: 'Não conectado', body: 'Informe a organização e um PAT dela.' },
    invalidOrganization: {
      title: 'Organização inválida',
      body: 'Use o nome da organização, como contoso, ou a URL, como https://dev.azure.com/contoso.'
    },
    secretsUnavailable: {
      title: 'Não dá para guardar o PAT com segurança',
      body: 'O Orca não tem um keyring do sistema para criptografar segredos nesta máquina (no Linux ele caiu para basic_text). Instale e desbloqueie um keyring, como o GNOME Keyring ou o KWallet, e reinicie o Orca.'
    },
    auth: {
      title: 'PAT recusado',
      body: 'O Azure DevOps não aceitou o PAT: pode estar errado, expirado, revogado ou ser de outra organização. Crie um novo para esta organização com o escopo Work Items (Read).'
    },
    scope: { title: 'Falta permissão', body: 'O PAT funciona, mas não tem o escopo Work Items (Read).' },
    notFound: { title: 'Não encontrado', body: 'Confira a organização e o nome do projeto.' },
    tls: {
      title: 'Certificado não confiável',
      body: 'O certificado do dev.azure.com não foi aceito, em geral porque um proxy da rede inspeciona HTTPS. Abra o Orca com NODE_EXTRA_CA_CERTS apontando para o arquivo da CA desse proxy.'
    },
    network: { title: 'Sem conexão', body: 'O servidor não respondeu. Confira a URL, a rede, a VPN ou o proxy.' },
    server: { title: 'Resposta inesperada', body: 'O Azure DevOps respondeu com um erro.' },
    writeScope: {
      title: 'O PAT não pode alterar work items',
      body: 'Crie um PAT para esta organização com o escopo Work Items (Read & write), apague o PAT guardado em Conexão nas configurações e conecte com o novo.'
    },
    rule: {
      title: 'O Azure DevOps recusou a mudança',
      body: 'A transição de estado ou uma regra do processo não permite. A mensagem do servidor segue abaixo.'
    },
    boardNotConfigured: { title: 'Nenhum board adicionado', body: 'Adicione o board de um time nas configurações.' },
    noCurrentIteration: {
      title: 'Sem iteração atual',
      body: 'O time não tem uma iteração que cubra hoje. Confira as iterações dele no Azure DevOps.'
    }
  }
}

function t(): Messages {
  return env.locale.toLowerCase().startsWith('pt') ? PT : EN
}

// ---------------------------------------------------------------------------------------------
// State

type Screen = { kind: 'loading' } | { kind: 'config' } | { kind: 'main' }
/**
 * `assigned`, a registered board's tab (`board-<teamId>`), or `board`: the one Board tab shown
 * while no board is registered, with its empty state.
 */
type TabId = string
type BoardData = Extract<BoardResult, { ok: true }>

/** What one tab shows. Each tab owns its data and loads it when first shown. */
type AssignedState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'list'; items: WorkItem[]; fetchedAt: number }
  | { kind: 'error'; error: ListError }
type BoardState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: BoardData }
  | { kind: 'error'; error: ListError }

type ProjectsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; projects: Project[]; complete: boolean }
  | { kind: 'error'; error: ListError }

/** Teams or boards of one parent (`key`), for the board picker. */
type Options<T> = { key: string } & (
  | { kind: 'loading' }
  | { kind: 'ready'; items: T[] }
  | { kind: 'error'; error: ListError }
)

/** The project and team Selects of the Boards section, for the next board to add. */
type BoardPick = { project: Project | null; team: Team | null }

/** What the config screen edits until Save; the PAT and the grouping are not part of it. */
type Draft = Pick<ConfigView, 'allProjects' | 'projects' | 'stripAreaPrefix' | 'hideClosed' | 'refreshMinutes' | 'boards'>

/**
 * The most Orca allows. The board's longest chain is five calls in a row in the worker (the board
 * and team settings, WIQL, fields, relations, children), each of up to 20 s.
 */
const REQUEST_TIMEOUT_MS = 120_000
/** How often the panel checks whether the data is due an automatic refresh. */
const REFRESH_CHECK_MS = 30_000
const REFRESH_CHOICES = [0, 5, 15, 30] as const
const HIDE_CLOSED_CHOICES: readonly HideClosed[] = ['off', 'children', 'all']
/** The project search box appears above this many projects. */
const SEARCH_THRESHOLD = 8

type StartOptions = Extract<StartOptionsResult, { ok: true }>
type StartState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; error: ListError | OrcaError }
  | { kind: 'form'; options: StartOptions }

const config = atom<ConfigView | null>(null)
const screen = atom<Screen>({ kind: 'loading' })
/** Save, Connect and similar calls; the tabs' own loads have their own flags. */
const busy = atom(false)
const assignedState = atom<AssignedState>({ kind: 'idle' })
/** What each registered board's tab shows, by team id; absent is idle. */
const boardStates = atom<Record<string, BoardState>>({})
const assignedBusy = atom(false)
/** The board tabs loading now, by team id. */
const boardBusy = atom<Record<string, boolean>>({})
/** The tab that is shown; kept across runs. */
const activeTab = atom<TabId>('activeTab', 'assigned', { persist: 'plugin' })
/** The error the last Connect got, shown on the config screen. */
const formError = atom<ListError | null>(null)
const notice = atom<string | null>(null)
/** Each tab's search row: whether it is shown, and what was typed (never persisted). */
const searchOpen = atom<Record<TabId, boolean>>({})
const searchQuery = atom<Record<TabId, string>>({})
const projectsState = atom<ProjectsState>({ kind: 'idle' })
const teamsState = atom<Options<Team> | null>(null)
const boardsState = atom<Options<BoardSummary> | null>(null)
/** The boards of each team (`${projectId}/${teamId}`), for the Board tab's level Select. */
const boardsCache = atom<Record<string, BoardSummary[]>>({})
const boardPick = atom<BoardPick>({ project: null, team: null })
/** Whether the config screen's Boards section is unfolded. */
const boardOpen = atom(false)
/** The config screen's unsaved preferences; null outside it. */
const draft = atom<Draft | null>(null)
/**
 * Collapsed groups, by `${groupBy}:${name}` and, on the board, `board:${boardId}:${columnId}`.
 * Absent: the default (open; outgoing board columns folded).
 */
/**
 * The item whose actions are open, as a path key: `${tab}:${id}` for a top-level item and
 * `${parentKey}>${childId}` for a child. One path at a time: an item is expanded when this is its
 * key or starts with `${key}>`.
 */
const expanded = atom<string | null>(null)
/** The entry keys whose children list is shown. */
const childrenOpen = atom<Record<string, boolean>>({})
/** What `item.children` last answered for each parent work item id. */
type ChildrenState = { kind: 'loading' } | { kind: 'ok'; items: BoardItem[] } | { kind: 'error'; error: ListError }
const childrenCache = atom<Record<number, ChildrenState>>({})
/** The `item.children` calls under way, so one parent is never asked twice at once. */
const childrenInflight = new Map<number, Promise<void>>()
/** The item being moved (same key), and the last refused move. */
const movingKey = atom<string | null>(null)
const moveError = atom<{ key: string; error: ListError } | null>(null)
/** Bumped after every move, so the Move to select remounts on its current value after a refusal. */
const moveAttempts = atom(0)
/** The item whose start form is open (same key as `expanded`), and what that form is showing. */
const startKey = atom<string | null>(null)
const startState = atom<StartState>({ kind: 'idle' })
/** The form's fields: the target (`agent:<terminalId>` or `new`), Orca project, worktree name, prompt. */
const startTarget = atom('new')
const startProject = atom('')
const startName = atom('')
const startAgentKind = atom('')
const startPrompt = atom('')
const startRunning = atom(false)
const startError = atom<ListError | OrcaError | null>(null)
/** The last successful send, shown at the top of its tab until the next action. */
const startSent = atom<{ tab: TabId; text: string } | null>(null)
let startRun = 0
const collapsedGroups = atom('collapsedGroups', {} as Record<string, boolean>, { persist: 'plugin' })
// What the person types. Never persisted: the PAT stays in memory until Connect sends it.
const draftOrg = atom('')
const draftPat = atom('')
const projectQuery = atom('')
/** Remounts the form so its fields take the current defaults. */
const formKey = atom(0)
/** Ignore the answer of a request that a newer one replaced. */
let projectsRun = 0
let teamsRun = 0
let boardsRun = 0
/** Whether the person can see the panel; set by setup. */
let visible: ReadonlyAtom<boolean> | null = null

/** Whether a config change alters which items the worker returns (grouping does not: it is local). */
function listInputsChanged(a: ConfigView, b: ConfigView): boolean {
  return (
    a.organization !== b.organization ||
    a.hasPat !== b.hasPat ||
    a.allProjects !== b.allProjects ||
    a.stripAreaPrefix !== b.stripAreaPrefix ||
    JSON.stringify(a.projects) !== JSON.stringify(b.projects) ||
    JSON.stringify(a.hiddenStates) !== JSON.stringify(b.hiddenStates)
  )
}

const NO_BOARD: TabId = 'board'
const BOARD_PREFIX = 'board-'

function boardTab(teamId: string): TabId {
  return `${BOARD_PREFIX}${teamId}`
}

/** The team of a board tab; null for Assigned to me and the no-board tab. */
function teamOf(tab: TabId): string | null {
  return tab.startsWith(BOARD_PREFIX) ? tab.slice(BOARD_PREFIX.length) : null
}

/** The tabs in order: Assigned to me, then one per registered board, or the no-board tab. */
function tabsOf(view: ConfigView | null): TabId[] {
  const boards = view?.boards ?? []
  return ['assigned', ...(boards.length > 0 ? boards.map((b) => boardTab(b.teamId)) : [NO_BOARD])]
}

/**
 * The tab to show for a stored choice: itself while it exists; a removed board (or `board`, the
 * single tab of earlier versions) falls to the first board, else to Assigned to me.
 */
function resolveTab(tab: TabId, view: ConfigView | null): TabId {
  const tabs = tabsOf(view)
  if (tabs.includes(tab)) return tab
  const firstBoard = view?.boards[0]
  if (teamOf(tab) !== null || tab === NO_BOARD) return firstBoard ? boardTab(firstBoard.teamId) : 'assigned'
  return 'assigned'
}

/** The tab that is shown. */
function currentTab(): TabId {
  return resolveTab(read(activeTab), read(config))
}

/** Puts the stored tab back on one that exists, after the boards changed. */
function fixTab(): void {
  const tab = currentTab()
  if (tab !== read(activeTab)) set(activeTab, tab)
}

/** Loads the tab that is shown when it has nothing yet (after fixTab moved to it). */
function loadIfIdle(): void {
  const tab = currentTab()
  if (stateOf(tab).kind === 'idle' && isConnected(read(config))) void loadTab(tab)
}

function boardStateOf(teamId: string): BoardState {
  return read(boardStates)[teamId] ?? { kind: 'idle' }
}

function stateOf(tab: TabId): AssignedState | BoardState {
  const team = teamOf(tab)
  return team === null ? read(assignedState) : boardStateOf(team)
}

/** The teams whose registered board is new or changed (another level, a rename) between two views. */
function changedTeams(a: ConfigView | null, b: ConfigView): string[] {
  const before = new Map((a?.boards ?? []).map((r) => [r.teamId, JSON.stringify(r)]))
  return b.boards.filter((r) => before.get(r.teamId) !== JSON.stringify(r)).map((r) => r.teamId)
}

/** Forgets what the tabs of boards no longer registered showed. */
function dropRemovedBoards(view: ConfigView): void {
  const teams = new Set(view.boards.map((b) => b.teamId))
  update(boardStates, (prev) => Object.fromEntries(Object.entries(prev).filter(([team]) => teams.has(team))))
}

/** Every tab but `keep` loads again when shown. */
function invalidateOthers(keep: TabId | null): void {
  for (const tab of tabsOf(read(config))) if (tab !== keep) invalidate(tab)
}

/**
 * The tab's label: the team's name, with the project when two registered teams share a name.
 */
function boardTabLabel(board: BoardRef, boards: readonly BoardRef[]): string {
  const shared = boards.filter((b) => b.teamName === board.teamName).length > 1
  return shared ? `${board.teamName} · ${board.projectName}` : board.teamName
}

function isConnected(view: ConfigView | null): boolean {
  return Boolean(view?.organization && view.hasPat)
}


function showConfig(unfoldBoard = false): void {
  const current = read(config)
  set(draftOrg, current?.organization ?? '')
  set(draftPat, '')
  set(projectQuery, '')
  set(formError, null)
  set(notice, null)
  set(formKey, read(formKey) + 1)
  set(projectsState, { kind: 'idle' })
  set(teamsState, null)
  set(boardsState, null)
  set(boardPick, { project: null, team: null })
  set(boardOpen, unfoldBoard)
  set(
    draft,
    current
      ? {
          allProjects: current.allProjects,
          projects: current.projects,
          stripAreaPrefix: current.stripAreaPrefix,
          hideClosed: current.hideClosed,
          refreshMinutes: current.refreshMinutes,
          boards: current.boards
        }
      : null
  )
  projectsRun++
  teamsRun++
  boardsRun++
  set(screen, { kind: 'config' })
  ensureProjects()
  ensureBoardOptions()
}

function failure(error: unknown): { ok: false; error: ListError } {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { kind: 'server', detail: message } }
}

function showAssigned(result: ListResult): void {
  if (result.ok) {
    set(assignedState, { kind: 'list', items: result.items, fetchedAt: result.fetchedAt })
  } else if (result.error.kind === 'notConfigured') {
    showConfig()
  } else {
    set(assignedState, { kind: 'error', error: result.error })
  }
}

function setBoardState(teamId: string, state: BoardState): void {
  update(boardStates, (prev) => ({ ...prev, [teamId]: state }))
}

function showBoard(teamId: string, result: BoardResult): void {
  if (result.ok) {
    setBoardState(teamId, { kind: 'ready', data: result })
    void ensureLevels(result.board)
  } else if (result.error.kind === 'notConfigured') {
    showConfig()
  } else if (result.error.kind === 'boardNotConfigured') {
    // The board was removed meanwhile (in another window): take the worker's list of boards.
    void syncConfig(teamId, result.error)
  } else {
    setBoardState(teamId, { kind: 'error', error: result.error })
  }
}

/**
 * Reads the config again and moves off a tab whose board is gone; if the board is still listed,
 * the tab shows the error instead.
 */
async function syncConfig(teamId: string, error: ListError): Promise<void> {
  let view: ConfigView
  try {
    view = await plugin.request('config.get')
  } catch {
    setBoardState(teamId, { kind: 'error', error })
    return
  }
  set(config, view)
  dropRemovedBoards(view)
  if (view.boards.some((b) => b.teamId === teamId)) setBoardState(teamId, { kind: 'error', error })
  fixTab()
  loadIfIdle()
}

/** A load asked for while the tab was already loading; it runs when that one ends. */
const reloadPending: Record<TabId, boolean> = {}

async function loadAssigned(): Promise<void> {
  if (read(assignedBusy)) {
    reloadPending.assigned = true
    return
  }
  set(assignedBusy, true)
  set(notice, null)
  if (read(assignedState).kind !== 'list') set(assignedState, { kind: 'loading' })
  try {
    showAssigned(await plugin.request('items.list', undefined, { timeoutMs: REQUEST_TIMEOUT_MS }))
  } catch (error) {
    showAssigned(failure(error))
  } finally {
    set(assignedBusy, false)
  }
  if (read(assignedState).kind === 'list') void reloadChildren('assigned')
  if (reloadPending.assigned) {
    reloadPending.assigned = false
    await loadAssigned()
  }
}

async function loadBoard(teamId: string): Promise<void> {
  const tab = boardTab(teamId)
  if (read(boardBusy)[teamId]) {
    reloadPending[tab] = true
    return
  }
  update(boardBusy, (prev) => ({ ...prev, [teamId]: true }))
  set(notice, null)
  if (boardStateOf(teamId).kind !== 'ready') setBoardState(teamId, { kind: 'loading' })
  try {
    showBoard(teamId, await plugin.request('board.get', { teamId }, { timeoutMs: REQUEST_TIMEOUT_MS }))
  } catch (error) {
    showBoard(teamId, failure(error))
  } finally {
    update(boardBusy, (prev) => ({ ...prev, [teamId]: false }))
  }
  if (boardStateOf(teamId).kind === 'ready') void reloadChildren(tab)
  if (reloadPending[tab]) {
    reloadPending[tab] = false
    await loadBoard(teamId)
  }
}

/** Fetches the team's boards once, for the level Select in the Board header. */
async function ensureLevels(ref: BoardRef): Promise<void> {
  const key = `${ref.projectId}/${ref.teamId}`
  if (read(boardsCache)[key]) return
  try {
    const result = await plugin.request(
      'boards.list',
      { projectId: ref.projectId, teamId: ref.teamId },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    )
    if (result.ok) update(boardsCache, (prev) => ({ ...prev, [key]: result.boards }))
  } catch {
    // The header then shows the board's own name only.
  }
}

/** Switches one board's level (Epics, Features, Stories...) and reloads that board. */
async function chooseLevel(teamId: string, boardId: string, boardName: string): Promise<void> {
  const boards = read(config)?.boards ?? []
  const ref = boards.find((b) => b.teamId === teamId)
  if (!ref || ref.boardId === boardId) return
  await savePrefs({ boards: boards.map((b) => (b.teamId === teamId ? { ...b, boardId, boardName } : b)) })
  await loadBoard(teamId)
}

function loadTab(tab: TabId): Promise<void> {
  const team = teamOf(tab)
  if (team !== null) return loadBoard(team)
  // The no-board tab shows its empty state: nothing to load.
  return tab === NO_BOARD ? Promise.resolve() : loadAssigned()
}

/** Reloads the tab that is shown (the refresh button, Try again, Back). */
function load(): Promise<void> {
  return loadTab(currentTab())
}

/** Drops what a tab shows, so it loads again when shown. */
function invalidate(tab: TabId): void {
  const team = teamOf(tab)
  if (team !== null) setBoardState(team, { kind: 'idle' })
  else if (tab === 'assigned') set(assignedState, { kind: 'idle' })
}

function selectTab(value: string): void {
  const tab = resolveTab(value, read(config))
  set(activeTab, tab)
  if (stateOf(tab).kind === 'idle' && isConnected(read(config))) void loadTab(tab)
}

async function loadProjects(): Promise<void> {
  const run = ++projectsRun
  set(projectsState, { kind: 'loading' })
  let next: ProjectsState
  try {
    const result = await plugin.request('projects.list', undefined, { timeoutMs: REQUEST_TIMEOUT_MS })
    next = result.ok
      ? { kind: 'ready', projects: result.projects, complete: result.complete }
      : { kind: 'error', error: result.error }
  } catch (error) {
    next = { kind: 'error', error: failure(error).error }
  }
  if (run === projectsRun) set(projectsState, next)
}

/** Fetches the project list once per opening of the config screen, when a section needs it. */
function ensureProjects(): void {
  const current = read(config)
  const edits = read(draft)
  if (read(screen).kind !== 'config' || !isConnected(current) || !edits) return
  if (edits.allProjects && !read(boardOpen)) return
  if (read(projectsState).kind === 'idle') void loadProjects()
}

async function loadTeams(projectId: string): Promise<void> {
  const run = ++teamsRun
  set(teamsState, { key: projectId, kind: 'loading' })
  let next: Options<Team>
  try {
    const result = await plugin.request('teams.list', { projectId }, { timeoutMs: REQUEST_TIMEOUT_MS })
    next = result.ok
      ? { key: projectId, kind: 'ready', items: result.teams }
      : { key: projectId, kind: 'error', error: result.error }
  } catch (error) {
    next = { key: projectId, kind: 'error', error: failure(error).error }
  }
  if (run === teamsRun) set(teamsState, next)
}

async function loadBoards(projectId: string, teamId: string): Promise<void> {
  const run = ++boardsRun
  const key = `${projectId}/${teamId}`
  set(boardsState, { key, kind: 'loading' })
  let next: Options<BoardSummary>
  try {
    const result = await plugin.request('boards.list', { projectId, teamId }, { timeoutMs: REQUEST_TIMEOUT_MS })
    next = result.ok ? { key, kind: 'ready', items: result.boards } : { key, kind: 'error', error: result.error }
  } catch (error) {
    next = { key, kind: 'error', error: failure(error).error }
  }
  if (next.kind === 'ready') update(boardsCache, (prev) => ({ ...prev, [key]: next.items }))
  if (run !== boardsRun) return
  set(boardsState, next)
}

/** Loads the teams of the chosen project and the boards of the chosen team, once each. */
function ensureBoardOptions(): void {
  if (read(screen).kind !== 'config' || !read(boardOpen) || !isConnected(read(config))) return
  const { project, team } = read(boardPick)
  if (project && read(teamsState)?.key !== project.id) void loadTeams(project.id)
  if (project && team && read(boardsState)?.key !== `${project.id}/${team.id}`) void loadBoards(project.id, team.id)
}

/** Changes the project or team to add; loads the teams and the team's boards. */
function setPick(next: BoardPick): void {
  set(boardPick, next)
  ensureBoardOptions()
}

/**
 * The board that Add would register for the picked team: its Stories board (else the first
 * level), once its boards have loaded; null before, or when the team is already registered.
 */
function boardToAdd(): BoardRef | null {
  const { project, team } = read(boardPick)
  const edits = read(draft)
  const boards = read(boardsState)
  if (!project || !team || !edits || edits.boards.some((b) => b.teamId === team.id)) return null
  if (boards?.key !== `${project.id}/${team.id}` || boards.kind !== 'ready') return null
  const board = defaultBoard(boards.items)
  return board
    ? { projectId: project.id, projectName: project.name, teamId: team.id, teamName: team.name, boardId: board.id, boardName: board.name }
    : null
}

/** Adds the picked team's board to the draft; the project stays picked for the next one. */
function addBoard(): void {
  const ref = boardToAdd()
  const edits = read(draft)
  if (!ref || !edits) return
  set(draft, { ...edits, boards: [...edits.boards, ref] })
  setPick({ project: read(boardPick).project, team: null })
}

function removeBoard(teamId: string): void {
  const edits = read(draft)
  if (edits) set(draft, { ...edits, boards: edits.boards.filter((b) => b.teamId !== teamId) })
}

/** Changes the config screen's draft; nothing is saved until Save. */
function editDraft(change: Partial<Draft>): void {
  const edits = read(draft)
  if (!edits) return
  set(draft, { ...edits, ...change })
  ensureProjects()
}

/** Saves the draft, then shows the tabs again. */
async function saveDraft(): Promise<void> {
  const edits = read(draft)
  if (!edits || read(busy)) return
  const before = read(config)
  set(busy, true)
  set(notice, null)
  let after: ConfigView
  try {
    after = await plugin.request('prefs.set', edits)
    set(config, after)
  } catch {
    set(notice, t().saveFailed)
    return
  } finally {
    set(busy, false)
  }
  set(draft, null)
  set(screen, { kind: 'main' })
  dropRemovedBoards(after)
  fixTab()
  // The tab that is shown reloads; the others load when shown, if what they list changed.
  const active = currentTab()
  if (!before || listInputsChanged(before, after)) invalidateOthers(active)
  else for (const team of changedTeams(before, after)) if (boardTab(team) !== active) invalidate(boardTab(team))
  await load()
}

/** Leaves the config screen without saving. */
function back(): void {
  set(draft, null)
  set(screen, { kind: 'main' })
  void load()
}

/**
 * Reloads the tab that is shown when automatic refresh is on, the panel is visible and its data is
 * older than the interval. Exported so the tests can drive the clock.
 */
export function refreshIfDue(now: number = Date.now()): boolean {
  const minutes = read(config)?.refreshMinutes ?? 0
  if (minutes <= 0 || read(screen).kind !== 'main' || read(busy)) return false
  if (visible && !read(visible)) return false
  const tab = currentTab()
  const team = teamOf(tab)
  const state = stateOf(tab)
  const fetchedAt = state.kind === 'list' ? state.fetchedAt : state.kind === 'ready' ? state.data.fetchedAt : null
  const loading = team === null ? read(assignedBusy) : Boolean(read(boardBusy)[team])
  if (fetchedAt === null || loading) return false
  if (now - fetchedAt < minutes * 60_000) return false
  void loadTab(tab)
  return true
}

/** Applies the preference at once, saves it, and puts the worker's answer in its place. */
async function savePrefs(prefs: Prefs): Promise<void> {
  const before = read(config)
  if (!before) return
  set(config, { ...before, ...prefs })
  try {
    set(config, await plugin.request('prefs.set', prefs))
  } catch {
    set(config, before)
    set(notice, t().saveFailed)
  }
  ensureProjects()
}

async function connect(): Promise<void> {
  if (read(busy)) return
  set(busy, true)
  set(formError, null)
  let result: ListResult
  try {
    const pat = read(draftPat)
    result = await plugin.request(
      'config.save',
      { organization: read(draftOrg), ...(pat ? { pat } : {}) },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    )
  } catch (error) {
    result = failure(error)
  } finally {
    set(busy, false)
  }
  if (result.ok) {
    set(draftPat, '')
    const view = await plugin.request('config.get')
    set(config, view)
    set(screen, { kind: 'main' })
    set(boardStates, {})
    fixTab()
    showAssigned(result)
    const team = teamOf(currentTab())
    if (team !== null) void loadBoard(team)
  } else {
    set(formError, result.error)
  }
}

async function forgetPat(): Promise<void> {
  set(config, await plugin.request('pat.clear'))
  invalidate('assigned')
  set(boardStates, {})
  showConfig()
}

async function open(item: WorkItem): Promise<void> {
  // First thing in the press handler, so the gesture is still valid.
  try {
    await shell.openExternal(item.url)
    set(notice, null)
  } catch {
    set(notice, t().openFailed)
  }
}

const isExpanded = (key: string): boolean => {
  const current = read(expanded)
  return current === key || (current !== null && current.startsWith(`${key}>`))
}

/** The work item id at the end of a path key. */
const keyId = (key: string): number => Number(key.slice(Math.max(key.lastIndexOf('>'), key.lastIndexOf(':')) + 1))

/** Folds an item and its descendants; its parent, if any, stays expanded. */
function foldItem(key: string): void {
  const cut = key.lastIndexOf('>')
  set(expanded, cut < 0 ? null : key.slice(0, cut))
  update(childrenOpen, (prev) =>
    Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key && !k.startsWith(`${key}>`)))
  )
}

function toggleItem(key: string): void {
  set(moveError, null)
  closeStart()
  if (isExpanded(key)) {
    foldItem(key)
  } else {
    set(startSent, null)
    set(expanded, key)
    // Open children lists stay only on the path to the item that opens.
    update(childrenOpen, (prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => key.startsWith(`${k}>`))))
  }
}

/** Asks for the children of a work item; a list already shown stays until the answer. */
function fetchChildren(id: number): Promise<void> {
  const running = childrenInflight.get(id)
  if (running) return running
  if (read(childrenCache)[id]?.kind !== 'ok') update(childrenCache, (prev) => ({ ...prev, [id]: { kind: 'loading' as const } }))
  const run = (async () => {
    let result: ChildrenResult
    try {
      result = await plugin.request('item.children', { id }, { timeoutMs: REQUEST_TIMEOUT_MS })
    } catch (error) {
      result = failure(error)
    }
    childrenInflight.delete(id)
    const next: ChildrenState = result.ok ? { kind: 'ok', items: result.items } : { kind: 'error', error: result.error }
    update(childrenCache, (prev) => ({ ...prev, [id]: next }))
  })()
  childrenInflight.set(id, run)
  return run
}

/** Shows or hides the children list of an entry; pressing again after a failure retries. */
function toggleChildren(key: string): void {
  if (read(childrenOpen)[key]) {
    update(childrenOpen, (prev) =>
      Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key && !k.startsWith(`${key}>`)))
    )
    if (read(expanded)?.startsWith(`${key}>`)) set(expanded, key)
    return
  }
  update(childrenOpen, (prev) => ({ ...prev, [key]: true }))
  void fetchChildren(keyId(key))
}

/**
 * After a tab reloads: forgets the children lists that are no longer open and asks again for the
 * ones still open on that tab.
 */
async function reloadChildren(tab: TabId): Promise<void> {
  const open = Object.keys(read(childrenOpen))
  const ids = new Set(open.map(keyId))
  update(childrenCache, (prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(Number(id)))))
  const mine = new Set(open.filter((k) => k.startsWith(`${tab}:`)).map(keyId))
  await Promise.all([...mine].map((id) => fetchChildren(id)))
}

function closeStart(): void {
  startRun++
  set(startKey, null)
  set(startState, { kind: 'idle' })
  set(startRunning, false)
  set(startError, null)
}

const isOrcaError = (error: ListError | OrcaError): error is OrcaError => error.kind === 'capability' || error.kind === 'orca'

/** The agent's state at a glance, first in its option: free, waiting for an answer, working, blocked. */
const AGENT_STATE_ICON: Record<OpenAgent['state'], string> = { done: '🟢', waiting: '🟡', working: '⏳', blocked: '🔴' }

/** Where the agent runs: its Orca project, or its workspace outside any project. */
function agentPlace(agent: OpenAgent): string {
  return agent.projectName || agent.workspaceName
}

/** An open agent in the Send to menu: `<state> <agent> · <project> · <title>`, the title when it has one. */
function agentLabel(agent: OpenAgent): string {
  const m = t()
  const text = [agent.agent || m.agentFallback, agentPlace(agent), agent.title].filter(Boolean).join(' · ')
  return `${AGENT_STATE_ICON[agent.state]} ${text}`
}

/** Opens (or closes, when open) the start form of an item and asks the worker what it offers. */
async function toggleStart(key: string, id: number): Promise<void> {
  if (read(startKey) === key) {
    closeStart()
    return
  }
  closeStart()
  set(startSent, null)
  const run = startRun
  set(startKey, key)
  set(startState, { kind: 'loading' })
  let result: StartOptionsResult
  try {
    result = await plugin.request('start.options', { id, locale: env.locale }, { timeoutMs: REQUEST_TIMEOUT_MS })
  } catch (error) {
    result = failure(error)
  }
  if (run !== startRun) return
  if (!result.ok) {
    set(startState, { kind: 'error', error: result.error })
    return
  }
  const first = result.agents[0]
  set(startTarget, first ? `agent:${first.terminalId}` : 'new')
  const last = result.projects.find((p) => p.id === result.lastProjectId) ?? result.projects[0]
  set(startProject, last?.id ?? '')
  set(startName, result.workspaceName)
  set(startAgentKind, result.lastAgent || result.agentKinds[0] || '')
  set(startPrompt, result.prompt)
  set(startState, { kind: 'form', options: result })
}

async function sendStart(tab: TabId, key: string, item: WorkItem, options: StartOptions): Promise<void> {
  if (read(startRunning)) return
  const m = t()
  const choice = read(startTarget)
  const prompt = read(startPrompt)
  const run = startRun
  let target: StartTarget
  let sent: string
  if (choice === 'new') {
    const project = options.projects.find((p) => p.id === read(startProject))
    if (!project) return
    const name = read(startName).trim()
    const agent = read(startAgentKind)
    if (!agent) return
    target = { kind: 'worktree', projectId: project.id, hostId: project.hostId, name, agent }
    sent = m.sentWorktree(name, agent)
  } else {
    const terminalId = choice.slice('agent:'.length)
    const agent = options.agents.find((a) => a.terminalId === terminalId)
    target = { kind: 'agent', terminalId }
    sent = m.sentToAgent(agent?.agent || m.agentFallback, agent ? agentPlace(agent) : '')
  }
  set(startRunning, true)
  set(startError, null)
  let result: StartResult
  try {
    result = await plugin.request(
      'start.run',
      { id: item.id, project: item.project, prompt, target },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    )
  } catch (error) {
    result = failure(error)
  }
  if (run !== startRun) return
  set(startRunning, false)
  if (result.ok) {
    closeStart()
    if (isExpanded(key)) foldItem(key)
    set(startSent, { tab, text: sent })
  } else {
    set(startError, result.error)
  }
}

/** Moves an item; on success the tab reloads and the other one loads when shown. */
async function moveItem(tab: TabId, key: string, id: number, target: MoveTarget, parentId: number | null): Promise<void> {
  if (read(movingKey)) return
  set(movingKey, key)
  set(moveError, null)
  let result: MoveResult
  try {
    result = await plugin.request('item.move', { id, target }, { timeoutMs: REQUEST_TIMEOUT_MS })
  } catch (error) {
    result = failure(error)
  }
  set(movingKey, null)
  update(moveAttempts, (n) => n + 1)
  if (result.ok) {
    if (isExpanded(key)) {
      closeStart()
      foldItem(key)
    }
    // The item may also show in Assigned to me and on other boards.
    invalidateOthers(tab)
    // The reload asks again for the open lists too, but only when it succeeds.
    await Promise.all([parentId === null ? undefined : fetchChildren(parentId), loadTab(tab)])
  } else {
    set(moveError, { key, error: result.error })
  }
}

export function setup(ctx: PanelContext): void {
  visible = ctx.visible
  const timer = setInterval(() => refreshIfDue(), REFRESH_CHECK_MS)
  // Under Node (the tests) a pending interval would keep the process alive.
  ;(timer as { unref?: () => void }).unref?.()
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  ctx.subscriptions.push(
    plugin.on('config.changed', (view) => {
      const before = read(config)
      set(config, view)
      // On the config screen, or while Save or Connect runs, that call shows the result. A tab
      // that is loading reloads once its load ends (its load read the settings before).
      if (read(screen).kind === 'config' || read(busy)) {
        ensureProjects()
        return
      }
      dropRemovedBoards(view)
      fixTab()
      const active = currentTab()
      // A change in Orca's Settings that alters the items reloads; a grouping change only regroups.
      const stale =
        !before || listInputsChanged(before, view) ? tabsOf(view) : changedTeams(before, view).map(boardTab)
      for (const tab of stale) {
        if (tab === active) void loadTab(tab)
        else invalidate(tab)
      }
      if (!stale.includes(active)) loadIfIdle()
    })
  )
  void plugin.request('config.get').then(
    (view) => {
      set(config, view)
      fixTab()
      if (isConnected(view)) {
        set(screen, { kind: 'main' })
        void load()
      } else showConfig()
    },
    (error) => {
      set(screen, { kind: 'main' })
      showAssigned(failure(error))
    }
  )
}

// ---------------------------------------------------------------------------------------------
// Views

function ErrorBox({ error }: { error: ListError }) {
  const m = t().errors[error.kind]
  return (
    <Callout tone="danger" title={m.title}>
      <Stack gap="xs">
        <Text>{m.body}</Text>
        {error.detail ? <Code>{error.detail}</Code> : null}
      </Stack>
    </Callout>
  )
}

/** Lowercase without accents, so "operacoes" finds "Operações". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * By id; by name only for an entry of the fallback list, whose id is its name, so two projects
 * named alike (`Operações`, `Operacoes`) stay apart.
 */
function sameProject(a: Project, b: Project): boolean {
  if (a.id === b.id) return true
  const fallback = a.id === a.name || b.id === b.name
  return fallback && fold(a.name) === fold(b.name)
}

function ProjectPicker() {
  const m = t()
  const state = read(projectsState)
  const query = fold(read(projectQuery).trim())
  const selected = read(draft)?.projects ?? []

  if (state.kind === 'idle' || state.kind === 'loading') return <Spinner label={m.loadingProjects} />
  if (state.kind === 'error') {
    return (
      <Stack gap="xs">
        <ErrorBox error={state.error} />
        <Row>
          <Button variant="outline" onPress={loadProjects}>
            {m.tryAgain}
          </Button>
        </Row>
      </Stack>
    )
  }

  // Chosen projects that the fetched list lacks stay listed (and ticked) until the person unticks them.
  const extras = selected.filter((s) => !state.projects.some((p) => sameProject(p, s)))
  const all = [...state.projects, ...extras].sort((a, b) => a.name.localeCompare(b.name))
  const visible = query ? all.filter((p) => fold(p.name).includes(query)) : all

  const toggle = (project: Project, checked: boolean): void => {
    const rest = selected.filter((s) => !sameProject(s, project))
    editDraft({ projects: checked ? [...rest, project] : rest })
  }

  return (
    <Stack gap="xs">
      {!state.complete ? <Callout tone="warning">{m.projectsIncomplete}</Callout> : null}
      {all.length > SEARCH_THRESHOLD ? (
        <Input
          label={m.searchProjects}
          labelHidden
          type="search"
          placeholder={m.searchProjects}
          defaultValue={read(projectQuery)}
          onChange={(value) => set(projectQuery, value)}
        />
      ) : null}
      <Box scroll="y" maxHeight={240} border radius="md" padding="xs" gap="xs">
        {visible.map((project) => (
          <Checkbox
            key={project.id}
            label={project.name}
            checked={selected.some((s) => sameProject(s, project))}
            onChange={(checked) => toggle(project, checked)}
          />
        ))}
      </Box>
      <Text muted size="xs">
        {selected.length === 0 ? m.noneSelected : m.selectedCount(selected.length)}
      </Text>
    </Stack>
  )
}

function ConfigScreen() {
  const m = t()
  const current = read(config)
  const edits = read(draft)
  const working = read(busy)
  const error = read(formError)
  const connected = isConnected(current)
  const message = read(notice)
  return (
    <Stack gap="sm" key={`form-${read(formKey)}`}>
      <Heading>{connected ? m.settingsTitle : m.connectTitle}</Heading>
      {connected ? null : (
        <Text muted size="sm">
          {m.connectIntro}
        </Text>
      )}
      {message ? <Callout tone="warning">{message}</Callout> : null}
      {connected && current && edits ? (
        // Connected: every section folds, stacked like the panel's groups. The PAT belongs to
        // the organization, so both change together, after the stored PAT is deleted.
        <Stack gap="sm">
          <Stack gap="none">
            <Collapsible
              title={m.connectionSection}
              description={`${current.organization} · ${m.patStoredLabel}`}
              defaultOpen={false}
            >
              <Stack gap="xs">
                {current.protection === 'unavailable' ? (
                  <Callout tone="warning" title={m.errors.secretsUnavailable.title}>
                    {m.errors.secretsUnavailable.body}
                  </Callout>
                ) : null}
                <Row justify="between" align="center" gap="xs">
                  <Text muted size="xs">
                    {m.changeConnectionHelp}
                  </Text>
                  <IconButton
                    icon="delete"
                    label={m.forgetPat}
                    variant="ghost"
                    tone="danger"
                    onPress={forgetPat}
                    disabled={working}
                  />
                </Row>
              </Stack>
            </Collapsible>
            <Collapsible
              title={m.projectsSection}
              description={edits.allProjects ? m.allProjects : m.selectedCount(edits.projects.length)}
              defaultOpen={!edits.allProjects}
            >
              <Stack gap="xs">
                <Switch
                  label={m.allProjects}
                  checked={edits.allProjects}
                  onChange={(checked) => editDraft({ allProjects: checked })}
                />
                {edits.allProjects ? null : <ProjectPicker />}
              </Stack>
            </Collapsible>
            <BoardSection />
            <Collapsible
              title={m.displaySection}
              description={[edits.stripAreaPrefix ? m.prefixRemoved : m.prefixKept, m.hideClosedSummary[edits.hideClosed]]
                .filter(Boolean)
                .join(' · ')}
            >
              <Stack gap="xs">
                <Switch
                  label={m.stripPrefix}
                  checked={edits.stripAreaPrefix}
                  onChange={(checked) => editDraft({ stripAreaPrefix: checked })}
                />
                <Text muted size="xs">
                  {m.stripPrefixHelp}
                </Text>
                <Row align="center" justify="between" gap="xs">
                  <Text size="sm">{m.hideClosedLabel}</Text>
                  <Box width={selectWidth(HIDE_CLOSED_CHOICES.map((value) => ({ label: m.hideClosedOptions[value] })))} shrink={false}>
                    <Select
                      label={m.hideClosedLabel}
                      labelHidden
                      value={edits.hideClosed}
                      options={HIDE_CLOSED_CHOICES.map((value) => ({ value, label: m.hideClosedOptions[value] }))}
                      onChange={(value) => editDraft({ hideClosed: value as HideClosed })}
                    />
                  </Box>
                </Row>
              </Stack>
            </Collapsible>
            <Collapsible title={m.refreshSection} description={m.refreshOptions[edits.refreshMinutes]}>
              <Select
                label={m.refreshLabel}
                labelHidden
                value={String(edits.refreshMinutes)}
                options={REFRESH_CHOICES.map((value) => ({
                  value: String(value),
                  label: m.refreshOptions[value]!
                }))}
                onChange={(value) => editDraft({ refreshMinutes: Number(value) })}
              />
            </Collapsible>
          </Stack>
          <Row justify="end" gap="xs">
            <Button variant="ghost" onPress={back} disabled={working}>
              {m.back}
            </Button>
            <Button onPress={saveDraft} disabled={working}>
              {working ? m.saving : m.save}
            </Button>
          </Row>
        </Stack>
      ) : connected ? null : (
        <Stack gap="sm">
          <Heading level={2}>{m.connectionSection}</Heading>
          {current?.protection === 'unavailable' ? (
            <Callout tone="warning" title={m.errors.secretsUnavailable.title}>
              {m.errors.secretsUnavailable.body}
            </Callout>
          ) : null}
          <Field label={m.orgLabel} description={m.orgHelp} required>
            <Input
              label={m.orgLabel}
              labelHidden
              defaultValue={read(draftOrg)}
              placeholder="contoso"
              onChange={(value) => set(draftOrg, value)}
            />
          </Field>
          <Field label={m.patLabel} description={m.patHelp} required>
            <Input
              label={m.patLabel}
              labelHidden
              type="password"
              onChange={(value) => set(draftPat, value)}
              onSubmit={() => void connect()}
            />
          </Field>
          {error ? <ErrorBox error={error} /> : null}
          <Row>
            <Button
              onPress={connect}
              disabled={working || !read(draftOrg).trim() || !read(draftPat).trim()}
            >
              {working ? m.connecting : m.connect}
            </Button>
          </Row>
        </Stack>
      )}
    </Stack>
  )
}

function StartError({ error }: { error: ListError | OrcaError }) {
  const m = t()
  if (!isOrcaError(error)) return <ErrorBox error={error} />
  if (error.kind === 'capability') {
    return (
      <Callout tone="warning" title={m.capabilityTitle}>
        <Text>{m.capabilityBody}</Text>
      </Callout>
    )
  }
  return (
    <Callout tone="danger" title={m.orcaRefused}>
      {error.detail ? <Code>{error.detail}</Code> : null}
    </Callout>
  )
}

/** The start form under an item's actions: where to send, the prompt, Send and Cancel. */
function StartForm({ tab, itemKey, item }: { tab: TabId; itemKey: string; item: WorkItem }) {
  const m = t()
  const state = read(startState)
  if (state.kind === 'idle') return null
  if (state.kind === 'loading') return <Spinner label={m.preparing} />
  if (state.kind === 'error') return <StartError error={state.error} />
  const { options } = state
  const running = read(startRunning)
  const choice = read(startTarget)
  const prompt = read(startPrompt)
  const error = read(startError)
  const worktree = choice === 'new'
  const project = options.projects.find((p) => p.id === read(startProject))
  const targets = [
    ...options.agents.map((a) => ({ value: `agent:${a.terminalId}`, label: agentLabel(a) })),
    { value: 'new', label: m.newWorktree }
  ]
  const agentKind = read(startAgentKind)
  const blocked = prompt.trim() === '' || (worktree && (!project || !agentKind || read(startName).trim() === ''))
  return (
    <Stack gap="xs">
      <InlineField label={m.sendTo}>
        <Select label={m.sendTo} labelHidden value={choice} options={targets} onChange={(value) => set(startTarget, value)} />
      </InlineField>
      {worktree ? (
        options.projects.length === 0 ? (
          <Text muted size="sm">
            {m.noGitProject}
          </Text>
        ) : (
          <Stack gap="xs">
            <InlineField label={m.startProject}>
              <Select
                label={m.startProject}
                labelHidden
                value={project?.id ?? ''}
                options={options.projects.map((p: OrcaProject) => ({ value: p.id, label: p.name }))}
                onChange={(value) => set(startProject, value)}
              />
            </InlineField>
            <InlineField label={m.startAgent}>
              <Select
                label={m.startAgent}
                labelHidden
                value={agentKind}
                options={options.agentKinds.map((kind) => ({ value: kind, label: kind }))}
                onChange={(value) => set(startAgentKind, value)}
              />
            </InlineField>
            <InlineField label={m.worktreeName}>
              <Input label={m.worktreeName} labelHidden value={read(startName)} onChange={(value) => set(startName, value)} />
            </InlineField>
          </Stack>
        )
      ) : null}
      <Textarea label={m.promptLabel} rows={8} value={prompt} onChange={(value) => set(startPrompt, value)} />
      <Row align="center" gap="xs" wrap>
        <Button variant="solid" size="sm" disabled={running || blocked} onPress={() => void sendStart(tab, itemKey, item, options)}>
          {m.send}
        </Button>
        <Button variant="ghost" size="sm" onPress={() => closeStart()}>
          {m.cancel}
        </Button>
        {running ? <Spinner label={m.sending} /> : null}
      </Row>
      {error ? <StartError error={error} /> : null}
    </Stack>
  )
}

/** The success note of the last send, at the top of its tab. */
function StartSent({ tab }: { tab: TabId }) {
  const sent = read(startSent)
  return sent && sent.tab === tab ? <Callout tone="success">{sent.text}</Callout> : null
}

/** A label on the left and its control on the right, the labels sharing one width. */
function InlineField({ label, children }: { label: string; children: OrcaNode }) {
  return (
    <Row align="center" gap="xs">
      <Box width={64} shrink={false}>
        <Text size="sm">{label}</Text>
      </Box>
      <Box grow>{children}</Box>
    </Row>
  )
}

function pickable<T extends { id: string; name: string }>(items: readonly T[], chosen: T | null): T[] {
  const all = chosen && !items.some((i) => i.id === chosen.id) ? [...items, chosen] : [...items]
  return all.sort((a, b) => a.name.localeCompare(b.name))
}

function optionsOf(items: readonly { id: string; name: string }[]) {
  return items.map((i) => ({ value: i.id, label: i.name }))
}

/** Team or board picker: a spinner while loading, the error when it failed, else a Select. */
function OptionsSelect<T extends { id: string; name: string }>({
  label,
  loadingLabel,
  empty,
  state,
  chosen,
  hideSelect,
  onPick,
  onRetry
}: {
  label: string
  loadingLabel: string
  empty: string
  state: Options<T> | null
  chosen: T | null
  /** Only report loading, errors and emptiness: the choice is made elsewhere. */
  hideSelect?: boolean
  onPick: (item: T) => void
  onRetry: () => void
}) {
  const m = t()
  if (!state || state.kind === 'loading') return <Spinner label={loadingLabel} />
  if (state.kind === 'error') {
    return (
      <Stack gap="xs">
        {state.error.kind === 'scope' ? (
          <Callout tone="warning" title={m.errors.scope.title}>
            {m.teamsScope}
          </Callout>
        ) : (
          <ErrorBox error={state.error} />
        )}
        <Row>
          <Button variant="outline" onPress={onRetry}>
            {m.tryAgain}
          </Button>
        </Row>
      </Stack>
    )
  }
  if (state.items.length === 0) {
    return (
      <Text muted size="xs">
        {empty}
      </Text>
    )
  }
  if (hideSelect) return null
  const items = pickable(state.items, chosen)
  return (
    <InlineField label={label}>
      <Select
        label={label}
        labelHidden
        value={chosen?.id ?? ''}
        placeholder={m.choose}
        options={optionsOf(items)}
        onChange={(value) => {
          const next = items.find((i) => i.id === value)
          if (next) onPick(next)
        }}
      />
    </InlineField>
  )
}

function BoardSection() {
  const m = t()
  const edits = read(draft)
  const registered = edits?.boards ?? []
  const pick = read(boardPick)
  const projects = read(projectsState)
  const teams = read(teamsState)
  const boards = read(boardsState)
  const { project, team } = pick
  // Only the options that belong to the current choice (an answer for another parent is stale).
  const teamsNow = project && teams?.key === project.id ? teams : null
  const boardsNow = project && team && boards?.key === `${project.id}/${team.id}` ? boards : null
  // A team is registered once: the ones already in the list are not offered again.
  const teamsLeft: Options<Team> | null =
    teamsNow && teamsNow.kind === 'ready'
      ? { ...teamsNow, items: teamsNow.items.filter((i) => !registered.some((b) => b.teamId === i.id)) }
      : teamsNow
  const allAdded = teamsNow?.kind === 'ready' && teamsNow.items.length > 0 && teamsLeft?.kind === 'ready' && teamsLeft.items.length === 0
  const toAdd = boardToAdd()
  return (
    <Collapsible
      title={m.boardSection}
      description={registered.length > 0 ? registered.map((b) => b.teamName).join(', ') : m.boardNotChosen}
      open={read(boardOpen)}
      onChange={(isOpen) => {
        set(boardOpen, isOpen)
        ensureProjects()
        ensureBoardOptions()
      }}
    >
      <Stack gap="xs">
        {registered.length > 0 ? (
          <Stack gap="none">
            {registered.map((b) => (
              <Row key={b.teamId} align="center" justify="between" gap="xs">
                <Box grow shrink minWidth={0}>
                  <Row align="center" gap="xs">
                    <Box shrink minWidth={0}>
                      <Text size="sm" truncate>
                        {`${b.teamName} · ${b.boardName}`}
                      </Text>
                    </Box>
                    <Box shrink minWidth={0}>
                      <Text muted size="xs" truncate>
                        {b.projectName}
                      </Text>
                    </Box>
                  </Row>
                </Box>
                <IconButton
                  icon="delete"
                  label={m.removeBoard(b.teamName)}
                  variant="ghost"
                  tone="danger"
                  onPress={() => removeBoard(b.teamId)}
                />
              </Row>
            ))}
          </Stack>
        ) : (
          <Text muted size="xs">
            {m.noBoardsYet}
          </Text>
        )}
        {projects.kind === 'idle' || projects.kind === 'loading' ? (
          <Spinner label={m.loadingProjects} />
        ) : projects.kind === 'error' ? (
          <Stack gap="xs">
            <ErrorBox error={projects.error} />
            <Row>
              <Button variant="outline" onPress={loadProjects}>
                {m.tryAgain}
              </Button>
            </Row>
          </Stack>
        ) : (
          <InlineField label={m.projectLabel}>
            <Select
              label={m.projectLabel}
              labelHidden
              value={project?.id ?? ''}
              placeholder={m.choose}
              options={optionsOf(pickable(projects.projects, project))}
              onChange={(value) => {
                const next = pickable(projects.projects, project).find((p) => p.id === value)
                if (next && next.id !== project?.id) setPick({ project: next, team: null })
              }}
            />
          </InlineField>
        )}
        {project ? (
          allAdded ? (
            <Text muted size="xs">
              {m.allTeamsAdded}
            </Text>
          ) : (
            <OptionsSelect
              label={m.teamLabel}
              loadingLabel={m.loadingTeams}
              empty={m.noTeams}
              state={teamsLeft}
              chosen={team}
              onPick={(next) => next.id !== team?.id && setPick({ project, team: next })}
              onRetry={() => void loadTeams(project.id)}
            />
          )
        ) : null}
        {project && team ? (
          <OptionsSelect
            label={m.boardLabel}
            loadingLabel={m.loadingBoards}
            empty={m.noBoards}
            state={boardsNow}
            chosen={null}
            hideSelect
            onPick={() => {}}
            onRetry={() => void loadBoards(project.id, team.id)}
          />
        ) : null}
        {project ? (
          <Row justify="end">
            <Button variant="outline" size="sm" icon="add" onPress={addBoard} disabled={!toAdd}>
              {m.addBoard}
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Collapsible>
  )
}

/** Child task progress and pull request count, each only when non-zero. */
function counters(item: WorkItem): string[] {
  const m = t()
  return [
    item.childrenTotal > 0 ? m.tasks(item.childrenDone, item.childrenTotal) : '',
    item.pullRequests > 0 ? m.pullRequests(item.pullRequests) : ''
  ]
}

/** The "Move to" choices of an item and how a choice becomes a target. */
type MoveSpec = {
  options: { value: string; label: string }[]
  value: string
  disabled?: boolean
  target: (value: string) => MoveTarget
}

function stateMove(item: WorkItem): MoveSpec {
  const names = item.states.includes(item.state) ? item.states : [item.state, ...item.states]
  return {
    options: names.map((name) => ({ value: name, label: name })),
    value: item.state,
    disabled: item.states.length === 0,
    target: (value) => ({ kind: 'state', state: value })
  }
}

/** Split columns offer two positions, `<id>:doing` and `<id>:done`. */
function columnMove(item: WorkItem, columns: BoardColumn[], teamId: string): MoveSpec {
  const m = t()
  const options = columns.flatMap((column) =>
    column.isSplit
      ? [
          { value: `${column.id}:doing`, label: `${column.name} · ${m.doing}` },
          { value: `${column.id}:done`, label: `${column.name} · ${m.done}` }
        ]
      : [{ value: column.id, label: column.name }]
  )
  const here = columns.find((column) => column.name === item.boardColumn)
  const value = here ? (here.isSplit ? `${here.id}:${item.boardColumnDone ? 'done' : 'doing'}` : here.id) : ''
  return {
    options,
    value,
    target: (choice) => {
      const [columnId = '', half] = choice.split(/:(?=doing$|done$)/)
      return { kind: 'column', teamId, columnId, done: half === 'done' }
    }
  }
}

/**
 * A width that fits the longest option, so no state or column is cut: about 7.5 px per character
 * at Orca's control text size, plus the select's padding and chevron. At most 320 px; the actions
 * row wraps when the panel is narrower.
 */
export function selectWidth(options: readonly { label: string }[]): number {
  const longest = Math.max(0, ...options.map((o) => o.label.length))
  return Math.min(320, Math.max(120, Math.ceil(longest * 7.5) + 48))
}

/**
 * The items the "Hide completed items" setting keeps: in the child lists for `children` and
 * `all`, in Assigned to me and the Board only for `all`.
 */
function withoutClosed<T extends WorkItem>(items: readonly T[], where: 'list' | 'children'): T[] {
  const mode = read(config)?.hideClosed ?? 'off'
  const hide = mode === 'all' || (mode === 'children' && where === 'children')
  return hide ? items.filter((item) => item.stateCategory !== 'Completed') : [...items]
}

/** What a child shows, like a board card but with its state: type, state, assignee, counters. */
function childDescription(item: BoardItem): string {
  return [item.type, item.state, item.assignedTo, ...counters(item)].filter(Boolean).join(' · ')
}

/** The children of an entry: a spinner, the error, an empty note, or an Entry per child. */
function ChildrenList({ tab, parent }: { tab: TabId; parent: { key: string; id: number } }) {
  const m = t()
  const state = read(childrenCache)[parent.id]
  if (!state || state.kind === 'loading') return <Spinner label={m.loadingChildren} />
  if (state.kind === 'error') return <ErrorBox error={state.error} />
  if (state.items.length === 0) {
    return (
      <Text size="sm" muted>
        {m.noChildren}
      </Text>
    )
  }
  const shown = withoutClosed(state.items, 'children')
  const hidden = state.items.length - shown.length
  const note =
    hidden > 0 ? (
      <Text size="sm" muted>
        {m.closedHidden(hidden)}
      </Text>
    ) : null
  if (shown.length === 0) return note
  return (
    <Stack gap="xs">
    <List label={m.childrenList}>
      {shown.map((child) => (
        <Entry
          key={String(child.id)}
          tab={tab}
          parent={parent}
          item={child}
          move={() => stateMove(child)}
          description={childDescription(child)}
          current={child.mine}
        />
      ))}
    </List>
    {note}
    </Stack>
  )
}

/**
 * An item that opens its actions when pressed: Close, Open in browser, Start work, Move to and
 * the children toggle. A child has `parent` (the entry it is listed under) and its key extends
 * the parent's.
 */
function Entry({
  tab,
  parent,
  item,
  description,
  current,
  move
}: {
  tab: TabId
  parent?: { key: string; id: number }
  item: WorkItem
  description: string
  current?: boolean
  move: () => MoveSpec
}) {
  const m = t()
  const key = parent ? `${parent.key}>${item.id}` : `${tab}:${item.id}`
  const icon = iconFor(item.typeIcon, item.type)
  const title = `#${item.id} ${item.title}`
  if (!isExpanded(key)) {
    return <ListItem icon={icon} title={title} description={description} current={current} onPress={() => toggleItem(key)} />
  }
  const spec = move()
  const running = read(movingKey) === key
  const failed = read(moveError)
  const childrenShown = read(childrenOpen)[key] === true
  // Two rows: the item itself stays pressable (pressing it again folds the actions), and a row
  // without onPress holds the controls, since a pressable row cannot contain them.
  return (
    <>
      <ListItem icon={icon} title={title} description={description} current={current} onPress={() => toggleItem(key)} />
      <ListItem>
      <Stack gap="xs">
        <Row align="center" gap="xs" wrap>
          <IconButton icon="collapse" label={m.closeItem} variant="ghost" onPress={() => toggleItem(key)} />
          <IconButton icon="globe" label={m.openInBrowser} variant="outline" onPress={() => open(item)} />
          <Button
            variant="outline"
            size="sm"
            icon="bot"
            onPress={() => void toggleStart(key, item.id)}
          >
            {m.startWork}
          </Button>
          <Box width={selectWidth(spec.options)} shrink={false}>
            <Select
              key={`${key}:${read(moveAttempts)}`}
              label={m.moveTo}
              labelHidden
              value={spec.value}
              placeholder={m.moveTo}
              options={spec.options}
              disabled={spec.disabled || read(movingKey) !== null}
              onChange={(value) => {
                if (value !== spec.value) void moveItem(tab, key, item.id, spec.target(value), parent?.id ?? null)
              }}
            />
          </Box>
          {item.childrenTotal > 0 ? (
            <Button
              variant="outline"
              size="sm"
              icon={childrenShown ? 'collapse' : 'expand'}
              tooltip={childrenShown ? m.hideChildren : m.showChildren}
              onPress={() => toggleChildren(key)}
            >
              {m.tasks(item.childrenDone, item.childrenTotal)}
            </Button>
          ) : null}
          {running ? <Spinner label={m.moving} /> : null}
        </Row>
        {failed && failed.key === key ? <ErrorBox error={failed.error} /> : null}
        {read(startKey) === key ? <StartForm tab={tab} itemKey={key} item={item} /> : null}
        {childrenShown ? <ChildrenList tab={tab} parent={{ key, id: item.id }} /> : null}
      </Stack>
      </ListItem>
    </>
  )
}

function Items({ items, groupBy, showProject, label }: { items: WorkItem[]; groupBy: GroupBy; showProject: boolean; label: string }) {
  return (
    <List label={label}>
      {items.map((item) => (
        <Entry
          key={String(item.id)}
          tab="assigned"
          item={item}
          move={() => stateMove(item)}
          description={[
            item.type,
            groupBy === 'state' ? '' : item.state,
            groupBy === 'none' ? item.boardColumn : '',
            ...counters(item),
            showProject ? item.project : ''
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      ))}
    </List>
  )
}

/** Shows or hides the tab's search row; hiding it clears the search. */
function toggleSearch(tab: TabId): void {
  const open = !read(searchOpen)[tab]
  update(searchOpen, (prev) => ({ ...prev, [tab]: open }))
  if (!open) update(searchQuery, (prev) => ({ ...prev, [tab]: '' }))
}

function SearchButton({ tab }: { tab: TabId }) {
  const m = t()
  const open = read(searchOpen)[tab]
  return <IconButton icon="search" label={m.search} variant={open ? 'outline' : 'ghost'} onPress={() => toggleSearch(tab)} />
}

function SearchRow({ tab }: { tab: TabId }) {
  const m = t()
  if (!read(searchOpen)[tab]) return null
  return (
    <Input
      label={m.searchLabel}
      labelHidden
      type="search"
      placeholder={m.searchPlaceholder}
      value={read(searchQuery)[tab] ?? ''}
      onChange={(value) => update(searchQuery, (prev) => ({ ...prev, [tab]: value }))}
    />
  )
}

function NoMatches() {
  return (
    <Text muted size="sm">
      {t().noMatches}
    </Text>
  )
}

function ListView({ items }: { items: WorkItem[] }) {
  const m = t()
  const groupBy = read(config)?.groupBy ?? 'none'
  const collapsed = read(collapsedGroups)
  const message = read(notice)
  const showProject = new Set(items.map((item) => item.project)).size > 1
  const query = read(searchQuery).assigned ?? ''
  const filtering = query.trim() !== ''
  const shown = filterItems(withoutClosed(items, 'list'), query)
  const groups = groupItems(shown, groupBy)
  return (
    <Stack gap="xs">
      <Row justify="end" align="center" gap="xs">
        <Toolbar label={m.assigned} gap="xs">
          <SearchButton tab="assigned" />
          <Box width={172} shrink>
            <Select
              label={m.groupBy}
              labelHidden
              value={groupBy}
              options={(['none', 'state', 'boardColumn'] as const).map((value) => ({ value, label: m.groupOptions[value] }))}
              onChange={(value) => void savePrefs({ groupBy: value as GroupBy })}
            />
          </Box>
          <IconButton icon="refresh" label={m.refresh} onPress={() => void load()} disabled={read(assignedBusy)} />
          <IconButton icon="settings" label={m.settings} onPress={() => showConfig()} />
        </Toolbar>
      </Row>
      <SearchRow tab="assigned" />
      <StartSent tab="assigned" />
      {message ? <Callout tone="warning">{message}</Callout> : null}
      {items.length === 0 ? (
        <EmptyState icon="check" title={m.emptyTitle} description={m.emptyBody} />
      ) : shown.length === 0 ? (
        <NoMatches />
      ) : groupBy === 'none' ? (
        <Items items={shown} groupBy={groupBy} showProject={showProject} label={m.assigned} />
      ) : (
        <Stack gap="none">
          {groups.map((group) => {
            const name = group.name || m.noColumn
            const key = `${groupBy}:${group.name}`
            return (
              <Collapsible
                key={key}
                title={`${name} · ${group.items.length}`}
                open={filtering || !collapsed[key]}
                onChange={(isOpen) => {
                  // While searching every group is open; folding then would only stick for later.
                  if (!filtering) update(collapsedGroups, (prev) => ({ ...prev, [key]: !isOpen }))
                }}
              >
                <Items items={group.items} groupBy={groupBy} showProject={showProject} label={name} />
              </Collapsible>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}

function Failure({ error }: { error: ListError }) {
  const m = t()
  return (
    <Stack gap="sm">
      <ErrorBox error={error} />
      <Row gap="xs" wrap>
        <Button onPress={() => void load()} disabled={read(assignedBusy) || Object.values(read(boardBusy)).some(Boolean)}>
          {m.tryAgain}
        </Button>
        <Button variant="ghost" onPress={() => showConfig()}>
          {m.settings}
        </Button>
      </Row>
    </Stack>
  )
}

function AssignedTab() {
  const m = t()
  const state = read(assignedState)
  if (state.kind === 'idle' || state.kind === 'loading') return <Spinner label={m.loading} />
  if (state.kind === 'error') return <Failure error={state.error} />
  return <ListView items={state.items} />
}

function BoardList({ teamId, items, label }: { teamId: string; items: BoardItem[]; label: string }) {
  const board = boardStateOf(teamId)
  const columns = board.kind === 'ready' ? board.data.columns : []
  return (
    <List label={label}>
      {items.map((item) => (
        <Entry
          key={String(item.id)}
          tab={boardTab(teamId)}
          item={item}
          move={() => columnMove(item, columns, teamId)}
          description={[item.type, item.assignedTo, ...counters(item)].filter(Boolean).join(' · ')}
          current={item.mine}
        />
      ))}
    </List>
  )
}

/** A split column shows Doing and Done; an empty half keeps its heading with a quiet dash. */
function Half({ teamId, title, items, label }: { teamId: string; title: string; items: BoardItem[]; label: string }) {
  const m = t()
  return (
    <Stack gap="none">
      <Text size="xs" weight="semibold" muted>
        {title}
      </Text>
      {items.length > 0 ? (
        <BoardList teamId={teamId} items={items} label={`${label} · ${title}`} />
      ) : (
        <Text muted size="xs">
          {m.emptyHalf}
        </Text>
      )}
    </Stack>
  )
}

function ColumnBody({ teamId, section }: { teamId: string; section: ColumnSection }) {
  const m = t()
  const name = section.column.name
  if (section.items.length === 0) {
    return (
      <Text muted size="xs">
        {m.noItems}
      </Text>
    )
  }
  if (!section.column.isSplit) return <BoardList teamId={teamId} items={section.items} label={name} />
  return (
    <Stack gap="none">
      <Half teamId={teamId} title={m.doing} items={section.doing} label={name} />
      <Half teamId={teamId} title={m.done} items={section.done} label={name} />
    </Stack>
  )
}

/** The team's boards in level order; only the current one until the list has loaded. */
function levelOptions(current: BoardRef, boards: BoardSummary[] | undefined) {
  const list = boards && boards.length > 0 ? sortBoards(boards) : [{ id: current.boardId, name: current.boardName }]
  return list.map((b) => ({ value: b.id, label: b.name }))
}

function BoardView({ teamId, data }: { teamId: string; data: BoardData }) {
  const m = t()
  const tab = boardTab(teamId)
  const collapsed = read(collapsedGroups)
  const message = read(notice)
  const query = read(searchQuery)[tab] ?? ''
  const filtering = query.trim() !== ''
  const layout = layoutBoard(data.columns, filterItems(withoutClosed(data.items, 'list'), query))
  const anyMatch = layout.other.length > 0 || layout.columns.some((section) => section.items.length > 0)
  const levels = read(boardsCache)[`${data.board.projectId}/${data.board.teamId}`]
  const fold = (key: string, byDefault: boolean) => (key in collapsed ? Boolean(collapsed[key]) : byDefault)
  const setFolded = (key: string, isOpen: boolean) => update(collapsedGroups, (prev) => ({ ...prev, [key]: !isOpen }))
  const otherKey = `board:${data.board.boardId}:other`
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Box grow shrink minWidth={0}>
          <Row align="center" gap="xs">
            <Box shrink minWidth={0}>
              <Text weight="semibold" truncate>
                {data.board.teamName}
              </Text>
            </Box>
            <Box shrink minWidth={0}>
              <Text muted size="sm" truncate>
                {data.iteration.name}
              </Text>
            </Box>
          </Row>
        </Box>
        <Box shrink={false}>
          <Toolbar label={m.tabBoard} gap="xs">
            <SearchButton tab={tab} />
            <Box width={120} shrink={false}>
              <Select
                label={m.boardLevel}
                labelHidden
                value={data.board.boardId}
                options={levelOptions(data.board, levels)}
                onChange={(value) => {
                  const next = (levels ?? []).find((b) => b.id === value)
                  if (next) void chooseLevel(teamId, next.id, next.name)
                }}
              />
            </Box>
            <IconButton icon="refresh" label={m.refresh} onPress={() => void load()} disabled={Boolean(read(boardBusy)[teamId])} />
            <IconButton icon="settings" label={m.settings} onPress={() => showConfig()} />
          </Toolbar>
        </Box>
      </Row>
      <SearchRow tab={tab} />
      <StartSent tab={tab} />
      {message ? <Callout tone="warning">{message}</Callout> : null}
      {filtering && !anyMatch ? <NoMatches /> : null}
      <Stack gap="none">
        {layout.columns.map((section) => {
          const key = `board:${data.board.boardId}:${section.column.id}`
          // While searching, only the columns with matches show, all open.
          if (filtering && section.items.length === 0) return null
          return (
            <Collapsible
              key={key}
              title={columnTitle(section.column, section.items.length)}
              open={filtering || !fold(key, startsFolded(section.column))}
              onChange={(isOpen) => {
                if (!filtering) setFolded(key, isOpen)
              }}
            >
              <ColumnBody teamId={teamId} section={section} />
            </Collapsible>
          )
        })}
        {layout.other.length > 0 ? (
          <Collapsible
            title={`${m.other} · ${layout.other.length}`}
            open={filtering || !fold(otherKey, false)}
            onChange={(isOpen) => {
              if (!filtering) setFolded(otherKey, isOpen)
            }}
          >
            <BoardList teamId={teamId} items={layout.other} label={m.other} />
          </Collapsible>
        ) : null}
      </Stack>
      {data.truncated ? (
        <Text muted size="xs">
          {m.truncated}
        </Text>
      ) : null}
    </Stack>
  )
}

/** The tab shown while no board is registered. */
function NoBoardTab() {
  const m = t()
  return (
    <EmptyState icon="layers" title={m.boardNotConfiguredTitle} description={m.boardNotConfiguredBody}>
      <Button onPress={() => showConfig(true)}>{m.chooseBoard}</Button>
    </EmptyState>
  )
}

function BoardTab({ teamId }: { teamId: string }) {
  const m = t()
  const state = boardStateOf(teamId)
  if (state.kind === 'idle' || state.kind === 'loading') return <Spinner label={m.loadingBoard} />
  if (state.kind === 'error') return <Failure error={state.error} />
  return <BoardView teamId={teamId} data={state.data} />
}

function Main() {
  const m = t()
  const state = read(assignedState)
  const boards = read(config)?.boards ?? []
  const tab = currentTab()
  return (
    <Tabs label={m.tabsLabel} value={tab} onChange={selectTab}>
      <Tab value="assigned" icon="check" label={m.tabAssigned(state.kind === 'list' ? state.items.length : null)}>
        {tab === 'assigned' ? <AssignedTab /> : null}
      </Tab>
      {boards.length === 0 ? (
        <Tab value={NO_BOARD} icon="blocks" label={m.tabBoard}>
          {tab === NO_BOARD ? <NoBoardTab /> : null}
        </Tab>
      ) : (
        boards.map((board) => {
          const value = boardTab(board.teamId)
          return (
            <Tab key={value} value={value} icon="blocks" label={boardTabLabel(board, boards)}>
              {tab === value ? <BoardTab teamId={board.teamId} /> : null}
            </Tab>
          )
        })
      )}
    </Tabs>
  )
}

export default function Panel() {
  const m = t()
  const view = read(screen)
  switch (view.kind) {
    case 'loading':
      return <Spinner label={m.loading} />
    case 'config':
      return <ConfigScreen />
    case 'main':
      return <Main />
  }
}
