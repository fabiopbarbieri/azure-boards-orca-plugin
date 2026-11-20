import { assert, test } from 'orca/testing'
import { buildPrompt, htmlToText, workspaceNameFor, type PromptInput } from './start'

test('htmlToText turns blocks into lines and lists into dashes', () => {
  assert.equal(htmlToText('<div>One<br>Two</div><p>Three</p>'), 'One\nTwo\nThree')
  assert.equal(htmlToText('<ul><li>a</li><li>b <b>bold</b></li></ul>'), '- a\n- b bold')
})

test('htmlToText decodes entities, named and numeric', () => {
  assert.equal(htmlToText('a&nbsp;b &amp; c &lt;d&gt; &quot;e&quot; &#39;f&#39; &#65;&#x42; &unknown;'), "a b & c <d> \"e\" 'f' AB &unknown;")
})

test('htmlToText collapses blank lines and trims', () => {
  assert.equal(htmlToText('  <div>a</div><div></div><div></div><div></div><div>b</div>  '), 'a\n\nb')
  assert.equal(htmlToText(''), '')
})

test('workspaceNameFor builds a slug without accents', () => {
  assert.equal(workspaceNameFor(123, 'Corrigir ação do botão: Salvar!'), 'wi-123-corrigir-acao-do-botao-salvar')
  assert.equal(workspaceNameFor(5, '  --Fix login--  '), 'wi-5-fix-login')
})

test('workspaceNameFor cuts a long title on a boundary', () => {
  const name = workspaceNameFor(9, 'Update the contoso web checkout flow to support gift cards')
  assert.equal(name, 'wi-9-update-the-contoso-web-checkout-flow-to')
  assert.equal(workspaceNameFor(9, 'Update the contoso web checkout flows tomorrow now'), 'wi-9-update-the-contoso-web-checkout-flows')
  assert.ok(name.length - 'wi-9-'.length <= 40)
  assert.equal(workspaceNameFor(9, 'x'.repeat(60)), `wi-9-${'x'.repeat(40)}`)
})

test('workspaceNameFor without a slug is just the id', () => {
  assert.equal(workspaceNameFor(7, '!!! ???'), 'wi-7')
  assert.equal(workspaceNameFor(7, ''), 'wi-7')
})

const input: PromptInput = {
  id: 42,
  type: 'Bug',
  title: 'Login fails',
  url: 'https://dev.azure.com/contoso/Web/_workitems/edit/42',
  organization: 'contoso',
  project: 'Web',
  description: '',
  acceptanceCriteria: '',
  reproSteps: ''
}

test('buildPrompt in Portuguese, without empty sections', () => {
  const text = buildPrompt(input, 'pt-BR')
  assert.ok(text.startsWith('Entenda o work item #42 do Azure Boards: Bug "Login fails".\nLink: https://dev.azure.com/contoso/Web/_workitems/edit/42\nOrganização: contoso · Projeto: Web\n\n'))
  assert.ok(text.includes('`az boards work-item show --id 42 --org https://dev.azure.com/contoso`'))
  assert.ok(text.endsWith('proponha um plano antes de alterar código.'))
  assert.ok(!text.includes('Descrição:'))
})

test('buildPrompt in English with every section', () => {
  const text = buildPrompt({ ...input, description: 'D', acceptanceCriteria: 'A', reproSteps: 'R' }, 'en-US')
  assert.ok(text.startsWith('Understand Azure Boards work item #42: Bug "Login fails".'))
  assert.ok(text.includes('Organization: contoso · Project: Web'))
  assert.ok(text.endsWith('\n\nDescription:\nD\n\nAcceptance criteria:\nA\n\nRepro steps:\nR'))
  assert.ok(buildPrompt({ ...input, description: 'D' }, 'pt').endsWith('\n\nDescrição:\nD'))
})

test('buildPrompt cuts each section at 3000 characters', () => {
  const text = buildPrompt({ ...input, description: 'a'.repeat(3000), reproSteps: 'b'.repeat(3001) }, 'en')
  assert.ok(text.includes(`Description:\n${'a'.repeat(3000)}\n\n`))
  assert.ok(text.endsWith(`Repro steps:\n${'b'.repeat(3000)}…`))
})
