# Azure Boards for Orca

An [Orca](https://github.com/stablyai/orca) plugin that lists the Azure Boards work items assigned to you in Azure DevOps Services (`https://dev.azure.com/<organization>`), opens them in the browser and moves them between states and board columns. It works on Linux and Windows and needs no Azure Repos: your code can live anywhere.

[Português (Brasil)](#português-brasil)

## What it does

- Adds an **Azure Boards** panel to Orca's sidebar with two tabs:
  - **Assigned to me**: the open work items assigned to you (`[System.AssignedTo] = @Me`), newest change first, up to 200, grouped by **state** (default), by **board column**, or not at all.
  - **Board**: your team's board for the current iteration, with every item on it, in the board's own columns and order, split columns as Doing and Done, WIP limits (`In Progress · 3/7`) and your own items highlighted. A menu switches between the team's Epics, Features and Stories boards (Stories by default).
- Shows each item's type by its icon, how many of its child items are done (`Tasks 1/4`) and how many GitHub pull requests are linked to it (`29 PRs`). Groups and columns fold, and the panel remembers which ones you folded.
- The magnifier next to each tab's menu opens a search box that filters the items by number (`123` or `#123`) or by a piece of the title, ignoring case and accents. Groups and columns with matches open while you search; closing the box clears it.
- Reloads the visible tab every 5 minutes while the panel is open (configurable, or off).
- Lets you pick which of the projects you have access to appear, or keep all of them, including ones you gain access to later. Projects you cannot access never show up.
- Hides the leading `[Team or area name]` from titles when it matches the item's area path, so `[Web Team] Fix login` reads `Fix login`. You can turn this off.
- Click an item to show its actions (the close button hides them):
  - **Open in browser** opens it in Azure DevOps in your system browser. The first time, Orca asks before it opens `dev.azure.com`.
  - **Move to** changes it right away: in **Assigned to me**, to another state of its type; in **Board**, to another column of the board, or the Doing or Done half of a split column. Moving to a column also sets the state the board maps that column to. The tab reloads afterwards. If Azure DevOps refuses the change (a state transition or a rule of your process), the panel shows its message.
- Explains what went wrong when it cannot list: a refused PAT, a missing scope, a wrong organization or project, an untrusted certificate or no connection.

## Setup

1. In Azure DevOps, open **User settings → Personal access tokens** and create a token **scoped to your organization** with the scopes of the features you use. Start with the read scopes and add more only when you want a feature that needs them; the panel says which scope is missing when you try it:
   - **Work Items (Read)**: required, lists your items and the board.
   - **Project and Team (Read)**: the project filter and the board picker.
   - **Work Items (Read & write)**: **Move to**.

   Microsoft is retiring global PATs, so do not pick "All accessible organizations".
2. Open the **Azure Boards** panel in Orca, enter the **Organization** (the name in `https://dev.azure.com/<organization>`, or paste the URL) and the **Personal access token**, and press **Connect**. The plugin saves them only after Azure DevOps accepts them.
3. Under **Projects**, keep **All projects** or untick it and choose among the projects you have access to.
4. Under **Board**, pick the project and the team whose board the **Board** tab shows.
5. Press **Save**. **Back** leaves without saving. The PAT is not part of Save: to change the organization or the PAT, delete the stored PAT with the trash button under **Connection**.

Without **Project and Team (Read)** the plugin still lists your work items, but the project filter can only offer the projects where you have items assigned, and the panel says so.

The PAT is stored in Orca's encrypted secrets, never in settings or logs, together with the organization that accepted it. It is only ever sent to `dev.azure.com` for that organization: if you change the organization, the panel asks for a PAT again. If Orca has no OS keyring to encrypt it (Linux without GNOME Keyring or KWallet, where Chromium falls back to `basic_text`), the panel says so and does not store it.

## Settings

Under **Settings → Plugins → Azure Boards**:

| Setting | Default | Effect |
|---|---|---|
| Organization | empty | The organization in `https://dev.azure.com/<organization>`. |
| Group work items by | State | No grouping, State or Board column. The panel's **Group by** menu changes the same setting. |
| Remove the area prefix from titles | on | Hides a leading `[...]` in titles when it matches a segment of the item's area path. In a compound bracket such as `[Web Team \| 1234 \| Service]` only the area goes: `[1234 \| Service]`. A bracket that does not start with the area, such as `[BUG]`, stays. |
| Refresh every | 5 minutes | Reloads the visible tab while the panel is visible: off, 5, 15 or 30 minutes. |
| Hidden states | `Closed, Done, Removed` | Comma-separated states left out of the list. Adjust it to your process. |

The project filter and the chosen team board are kept in the plugin's own storage, by id, so renaming a project does not break them.

The settings labels are in English because Orca does not yet let plugins translate their manifest. The panel follows Orca's language (English and Brazilian Portuguese).

### Known limitations

- Azure DevOps Services only. Azure DevOps Server (on-premises) is not supported.
- Up to 200 items per tab.
- In **Assigned to me**, grouping by board column orders the columns by state category (Proposed, In Progress, Resolved), which is close to, but not always exactly, a board's order. The **Board** tab uses the real board order.
- Type icons are Orca's own icons mapped from Azure DevOps icon names, not the Azure DevOps artwork.
- Untested: Node's built-in `fetch` may ignore the system proxy and `HTTPS_PROXY`. On a network that requires a proxy the panel would show **No connection**. A proxy that inspects HTTPS shows **Certificate not trusted**; start Orca with `NODE_EXTRA_CA_CERTS` pointing to the proxy's CA file. Whether Orca passes that variable to plugin workers is not confirmed yet. The plugin never turns certificate checks off.

## Install

Requires Orca 1.4.264 or newer.

```bash
orca plugin install fabiopbarbieri/azure-boards-orca-plugin
```

Orca shows what the plugin asks for and prints an approval fingerprint; run the command again with `--approve <fingerprint>`. You can also install it from **Settings → Plugins**.

The plugin runs as a `trusted-worker`, which means a Node.js process with your user's access. It asks for three capabilities only: its own settings (`settings:own`), its own encrypted secrets (`secrets:own`) and its own storage (`storage:own`, for the project filter and the team board). It talks only to `dev.azure.com`, and the panel itself has no network access.

## How it works

The panel never touches the network. It asks the worker with `plugin.request`. For **Assigned to me** the worker sends a WIQL query (`POST https://dev.azure.com/{organization}/_apis/wit/wiql?api-version=7.1`, filtered by `[System.TeamProject] IN (...)` when you picked projects) and fetches the fields of the returned ids in one call (`POST .../_apis/wit/workitemsbatch`). For **Board** it reads the team board (`GET .../{project}/{team}/_apis/work/boards/{board}`: columns, splits, WIP limits and the board's own column fields), the team's current iteration and area paths (`.../work/teamsettings`), and runs a team-scoped WIQL query for that iteration and those areas. **Move to** sends `PATCH .../_apis/wit/workitems/{id}` (`application/json-patch+json`) with `System.State`, plus, for a board column, the board's own column and Done fields. Both tabs read the items' relations (`workitemsbatch` with `$expand=relations`) to count child items and GitHub pull request links, and each project's work item types once an hour (`GET .../{project}/_apis/wit/workitemtypes`) for icons and state categories. The project and team pickers use `GET .../_apis/projects` and `GET .../_apis/projects/{project}/teams`. Every call sends `Authorization: Basic base64(":" + PAT)`. A refused PAT can come back as 401, as a redirect to the sign-in page or as a 203 with HTML; all three read as **PAT refused**.

## Development

```bash
orca plugin validate .
orca plugin test .
orca plugin check .
npx -p typescript tsc -p .
orca plugin dev load . --approve <fingerprint>
orca plugin logs fabiopbarbieri.azure-boards
```

## Not planned now (Sonho)

The plugin lists, opens and moves items. These ideas are recorded, but we are not building them now:

- **Start work from an item**: create an Orca workspace (`workspace.create`) with an agent and a prompt built from the work item.
- **Comment** on a work item.
- **Link a branch or pull request** to a work item.
- **Move to `taskSources`** once Orca ships it, so the items show up in Orca's own Tasks view instead of a panel.

## License

[MIT](LICENSE)

---

## Português (Brasil)

Plugin do [Orca](https://github.com/stablyai/orca) que lista os work items do Azure Boards atribuídos a você no Azure DevOps Services (`https://dev.azure.com/<organização>`), abre cada um no navegador e move entre estados e colunas do board. Funciona no Linux e no Windows e não precisa do Azure Repos: o código pode estar em qualquer lugar.

**O que faz**

- Painel **Azure Boards** na barra lateral do Orca com os work items abertos atribuídos a você, do mais recente para o mais antigo, até 200.
- Duas abas: **Atribuídos a mim**, com os seus itens abertos agrupados por **estado** (padrão), por **coluna do board** ou sem agrupamento; e **Board**, com o board do seu time na iteração atual, todos os itens, nas colunas e na ordem do board, colunas divididas em Em andamento e Concluído, limites de WIP e os seus itens destacados. Um menu alterna entre os boards Epics, Features e Stories do time (Stories por padrão).
- Mostra o tipo de cada item pelo ícone, quantos filhos estão concluídos (`Tarefas 1/4`) e quantos PRs do GitHub estão vinculados (`29 PRs`). Grupos e colunas recolhem, e o painel lembra quais você recolheu.
- A lupa ao lado do menu de cada aba abre uma busca que filtra os itens pelo número (`123` ou `#123`) ou por um trecho do título, sem diferenciar maiúsculas nem acentos. Grupos e colunas com resultados abrem durante a busca; fechar a lupa limpa a busca.
- Atualiza a aba visível a cada 5 minutos com o painel aberto (configurável, ou desligado).
- Permite escolher quais dos projetos a que você tem acesso aparecem, ou manter todos, inclusive os que você ganhar acesso depois. Projetos sem acesso nunca aparecem.
- Esconde o `[Nome do time ou da área]` do começo do título quando ele bate com a área do item: `[Time Web] Ajustar login` vira `Ajustar login`. Dá para desligar.
- Clique num item para ver as ações dele (o botão de fechar as esconde):
  - **Abrir no navegador** abre o item no Azure DevOps, no navegador do sistema. Na primeira vez, o Orca pede confirmação para abrir o `dev.azure.com`.
  - **Mover para** muda o item na hora: em **Atribuídos a mim**, para outro estado do tipo; em **Board**, para outra coluna do board, ou para a metade Em andamento ou Concluído de uma coluna dividida. Mover para uma coluna também aplica o estado que o board associa a ela. A aba recarrega em seguida. Se o Azure DevOps recusar (transição de estado ou regra do processo), o painel mostra a mensagem dele.
- Quando não consegue listar, explica o motivo: PAT recusado, falta de escopo, organização ou projeto errados, certificado não confiável ou falta de conexão.

**Configurar**

1. Crie um personal access token (PAT) **escopado à sua organização**, com os escopos dos recursos que você usa. Comece pelos de leitura e aumente só quando quiser um recurso que precise de mais; o painel diz qual escopo falta quando você tenta: **Work Items (Read)** (obrigatório: lista e board), **Project and Team (Read)** (filtro de projetos e escolha do board) e **Work Items (Read & write)** (**Mover para**). A Microsoft está desativando os PATs globais.
2. No painel, informe a organização (o nome ou a URL) e o PAT, e clique em **Conectar**. Nada é salvo antes de o Azure DevOps aceitar.
3. Em **Projetos**, mantenha **Todos os projetos** ou desmarque e escolha entre os projetos a que você tem acesso.
4. Em **Board**, escolha o projeto e o time cujo board a aba **Board** mostra.
5. Clique em **Salvar**. **Voltar** sai sem salvar. O PAT não entra no Salvar: para trocar a organização ou o PAT, apague o PAT guardado com a lixeira em **Conexão**.

Sem o **Project and Team (Read)**, a lista funciona, mas o filtro só oferece os projetos onde você tem itens atribuídos, e o painel avisa.

O PAT fica nos segredos criptografados do Orca, nunca nas configurações nem nos logs, junto com a organização que o aceitou, e só é enviado ao `dev.azure.com` dessa organização. Se a organização mudar, o painel pede o PAT de novo. Sem um keyring do sistema (Linux sem GNOME Keyring ou KWallet), o painel avisa e não guarda o PAT.

Só o Azure DevOps Services (cloud) é suportado; o Azure DevOps Server (on-premises) não.

**Instalar**

```bash
orca plugin install fabiopbarbieri/azure-boards-orca-plugin
```

### Sonho

O "sonho" é o que fica registrado, mas não vamos fazer agora:

- **Iniciar trabalho a partir do item**: criar um workspace no Orca (`workspace.create`) com um agente e um prompt montado a partir do work item.
- **Comentar** no work item.
- **Vincular branch ou PR** ao work item.
- **Migrar para `taskSources`** quando o Orca lançar esse recurso, para os itens aparecerem na tela nativa de Tasks em vez de num painel.
