// "Start work": the pure parts. Turns an Azure DevOps work item into the prompt and the workspace
// (worktree) name that are proposed to the person.

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function codePoint(n: number, original: string): string {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original
  } catch {
    return original
  }
}

/** Azure DevOps rich text (HTML) as plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)\s*>/gi, '\n')
    .replace(/<li(\s[^>]*)?>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+)|#39);/gi, (match, hex?: string, dec?: string, name?: string) => {
      if (hex) return codePoint(parseInt(hex, 16), match)
      if (dec) return codePoint(parseInt(dec, 10), match)
      if (name) return ENTITIES[name.toLowerCase()] ?? match
      return "'"
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const SLUG_MAX = 40

/** `wi-<id>-<slug of the title>`, or `wi-<id>` when the title leaves no slug. */
export function workspaceNameFor(id: number, title: string): string {
  let slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length > SLUG_MAX) {
    const head = slug.slice(0, SLUG_MAX + 1)
    const boundary = head.lastIndexOf('-')
    // Cut at the last hyphen within the limit; mid-word when there is none.
    slug = boundary > 0 ? head.slice(0, boundary) : slug.slice(0, SLUG_MAX)
    slug = slug.replace(/-+$/, '')
  }
  return slug ? `wi-${id}-${slug}` : `wi-${id}`
}

export type PromptInput = {
  id: number
  type: string
  title: string
  url: string
  organization: string
  project: string
  description: string
  acceptanceCriteria: string
  reproSteps: string
}

const SECTION_MAX = 3000

function cut(text: string): string {
  return text.length > SECTION_MAX ? `${text.slice(0, SECTION_MAX)}…` : text
}

/** The prompt proposed for the agent; Portuguese for a `pt` locale, English otherwise. */
export function buildPrompt(input: PromptInput, locale: string): string {
  const pt = locale.toLowerCase().startsWith('pt')
  const { id, type, title, url, organization, project } = input
  const cli = `az boards work-item show --id ${id} --org https://dev.azure.com/${organization}`
  let text = pt
    ? `Entenda o work item #${id} do Azure Boards: ${type} "${title}".\nLink: ${url}\nOrganização: ${organization} · Projeto: ${project}\n\n` +
      `Busque mais informações sobre ele no Azure Boards com o CLI ou o MCP que você tiver disponível (por exemplo, \`${cli}\` ou o MCP do Azure DevOps): comentários, itens filhos, itens relacionados, links e histórico. Depois explique o seu entendimento e proponha um plano antes de alterar código.`
    : `Understand Azure Boards work item #${id}: ${type} "${title}".\nLink: ${url}\nOrganization: ${organization} · Project: ${project}\n\n` +
      `Look for more information about it in Azure Boards with whichever CLI or MCP you have available (for example, \`${cli}\` or the Azure DevOps MCP): comments, child items, related items, links and history. Then explain your understanding and propose a plan before changing any code.`
  const sections: [string, string][] = [
    [pt ? 'Descrição' : 'Description', input.description],
    [pt ? 'Critérios de aceite' : 'Acceptance criteria', input.acceptanceCriteria],
    [pt ? 'Passos para reproduzir' : 'Repro steps', input.reproSteps]
  ]
  for (const [label, body] of sections) {
    if (body) text += `\n\n${label}:\n${cut(body)}`
  }
  return text
}
