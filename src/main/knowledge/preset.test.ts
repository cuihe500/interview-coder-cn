import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readKnowledgePreset } from './preset'

let directory: string

async function writePreset(preset: unknown) {
  await writeFile(join(directory, 'preset.json'), JSON.stringify(preset))
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'knowledge-preset-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('bundled knowledge preset', () => {
  it('returns null when the installer ships no preset', async () => {
    expect(await readKnowledgePreset(directory)).toBeNull()
    expect(await readKnowledgePreset(join(directory, 'missing'))).toBeNull()
  })

  it('lists supported documents in order and resolves key documents', async () => {
    await writePreset({
      id: 'resume-pack',
      profile: { name: ' 简历知识库 ', role: '前端开发工程师' },
      keyDocuments: ['02-b.md', 'not-bundled.md']
    })
    await writeFile(join(directory, '02-b.md'), '# B')
    await writeFile(join(directory, '01-a.md'), '# A')
    await writeFile(join(directory, 'notes.json'), '{}')

    const preset = await readKnowledgePreset(directory)

    expect(preset).toMatchObject({
      id: 'resume-pack',
      activate: true,
      profile: { name: '简历知识库', company: '', role: '前端开发工程师', jobDescription: '' },
      filePaths: [join(directory, '01-a.md'), join(directory, '02-b.md')],
      keyDocumentPaths: [join(directory, '02-b.md')]
    })
  })

  it('changes version when a bundled document changes so upgrades re-apply it', async () => {
    await writePreset({ id: 'resume-pack', profile: { name: '简历知识库' } })
    await writeFile(join(directory, '01-a.md'), '# A')
    const first = await readKnowledgePreset(directory)
    expect((await readKnowledgePreset(directory))?.version).toBe(first?.version)

    await writeFile(join(directory, '01-a.md'), '# A updated')

    expect((await readKnowledgePreset(directory))?.version).not.toBe(first?.version)
  })

  it('rejects presets without an id, a profile name or documents', async () => {
    await writePreset({ id: '', profile: { name: '简历知识库' } })
    await expect(readKnowledgePreset(directory)).rejects.toThrow('id')

    await writePreset({ id: 'resume-pack', profile: {} })
    await expect(readKnowledgePreset(directory)).rejects.toThrow('profile.name')

    await writePreset({ id: 'resume-pack', profile: { name: '简历知识库' } })
    await expect(readKnowledgePreset(directory)).rejects.toThrow('没有可导入的文档')
  })
})
