import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const manifestSchema = z.object({
  version: z.literal(1),
  builtAt: z.iso.datetime(),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
})

export async function fingerprint(directory) {
  const files = {}
  async function walk(relative = '') {
    const entries = await readdir(join(directory, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (path === 'manifest.json') continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        files[path] = createHash('sha256')
          .update(await readFile(join(directory, path)))
          .digest('hex')
      } else throw new Error(`Unsupported artifact entry: ${path}`)
    }
  }
  await walk()
  return files
}

export function identity(files) {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

export async function verifyArtifacts(directory) {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
  )
  const files = await fingerprint(directory)
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error('Artifact checksum mismatch')
  for (const required of ['web/index.html', 'api.cjs', 'migrate.cjs']) {
    if (!files[required]) throw new Error(`Missing artifact: ${required}`)
  }
  if (!Object.keys(files).some((path) => /^migrations\/.+\/migration.sql$/.test(path))) {
    throw new Error('Missing migration SQL')
  }
  return { ...manifest, sha256: identity(files) }
}
