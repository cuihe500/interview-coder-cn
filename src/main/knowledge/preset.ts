import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { KNOWLEDGE_DOCUMENT_EXTENSIONS, type KnowledgeProfileInput } from '../../preload/contracts'

export const KNOWLEDGE_PRESET_MANIFEST = 'preset.json'

/**
 * A job profile bundled with an installer (resources/preset-knowledge). The
 * directory holds preset.json plus the documents to import next to it.
 */
export type KnowledgePreset = {
  id: string
  // Changes whenever preset.json or any bundled document changes, so a new
  // installer re-applies the preset once while an unchanged one leaves it alone.
  version: string
  profile: KnowledgeProfileInput
  keyDocumentPaths: string[]
  activate: boolean
  filePaths: string[]
}

const SUPPORTED_EXTENSIONS = new Set<string>(KNOWLEDGE_DOCUMENT_EXTENSIONS)

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function readKnowledgePreset(directory: string): Promise<KnowledgePreset | null> {
  let raw: string
  try {
    raw = await readFile(join(directory, KNOWLEDGE_PRESET_MANIFEST), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>
  const id = text(parsed.id)
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('预置知识库 preset.json 缺少有效的 id')
  const profile = (parsed.profile ?? {}) as Record<string, unknown>
  const name = text(profile.name)
  if (!name) throw new Error('预置知识库 preset.json 缺少 profile.name')

  const fileNames = (await readdir(directory))
    .filter((fileName) => SUPPORTED_EXTENSIONS.has(extname(fileName).toLowerCase()))
    .sort()
  if (!fileNames.length) throw new Error('预置知识库中没有可导入的文档')

  const hash = createHash('sha256').update(raw)
  for (const fileName of fileNames) {
    hash.update(`\0${fileName}\0`).update(await readFile(join(directory, fileName)))
  }

  const keyDocuments = new Set(
    Array.isArray(parsed.keyDocuments) ? parsed.keyDocuments.map(text) : []
  )
  return {
    id,
    version: hash.digest('hex'),
    profile: {
      name,
      company: text(profile.company),
      role: text(profile.role),
      jobDescription: text(profile.jobDescription)
    },
    keyDocumentPaths: fileNames
      .filter((fileName) => keyDocuments.has(fileName))
      .map((fileName) => join(directory, fileName)),
    activate: parsed.activate !== false,
    filePaths: fileNames.map((fileName) => join(directory, fileName))
  }
}
