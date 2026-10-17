import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
} from 'node:crypto'
import { z } from 'zod'

// Match the encrypted artifact's one-day retention, rather than imposing a separate review deadline.
const planLifetimeMs = 24 * 60 * 60 * 1000
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const identitySchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  runId: z.string().regex(/^\d+$/),
  runAttempt: z.string().regex(/^[1-9]\d*$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  account: z.string().regex(/^\d{12}$/),
  region: z.string().min(1),
  bucket: z.string().min(3),
  backendKey: z.string().min(1),
  workspace: z.string().min(1),
  workspacePath: z.string().min(1),
  terraformVersion: z.string().min(1),
  configurationSha256: digest,
  providerLockSha256: digest,
})
export type Identity = z.infer<typeof identitySchema>
export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  identity: identitySchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  files: z.record(z.string(), digest),
})
export type Manifest = z.infer<typeof manifestSchema>
const bundleSchema = z.object({ manifest: manifestSchema, files: z.record(z.string(), z.string()) })
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  key: z.string(),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
})
const validFile = (name: string) =>
  name === '.local/deploy/plan.tfplan' ||
  name === 'packages/api/dist/api-lambda.zip' ||
  (name.startsWith('packages/web/dist/') &&
    !name
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '..' ||
          part === '.' ||
          part.includes('\\') ||
          [...part].some((character) => character.charCodeAt(0) < 32),
      ))
const requiredFiles = [
  '.local/deploy/plan.tfplan',
  'packages/api/dist/api-lambda.zip',
  'packages/web/dist/index.html',
]

export function assertFreshManifest(input: unknown, expected: Identity, now: Date): Manifest {
  const manifest = manifestSchema.parse(input)
  const created = Date.parse(manifest.createdAt)
  const expiry = Date.parse(manifest.expiresAt)
  if (
    Object.entries(identitySchema.parse(expected)).some(
      ([name, value]) => manifest.identity[name as keyof Identity] !== value,
    ) ||
    created > now.getTime() ||
    expiry <= now.getTime() ||
    expiry <= created ||
    expiry - created > planLifetimeMs
  )
    throw new Error('Expired or mismatched deployment; create a new run and review')
  return manifest
}

export function createManifest(
  identity: Identity,
  files: Record<string, Buffer>,
  now: Date,
): Manifest {
  if (!requiredFiles.every((name) => files[name]) || !Object.keys(files).every(validFile))
    throw new Error('Missing or invalid deployment files')
  return manifestSchema.parse({
    schemaVersion: 1,
    identity,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + planLifetimeMs).toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha256(data)])),
  })
}

export function sealBundle(manifest: Manifest, files: Record<string, Buffer>, publicKey: string) {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const payload = JSON.stringify({
    manifest,
    files: Object.fromEntries(
      Object.entries(files).map(([name, data]) => [name, data.toString('base64')]),
    ),
  })
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  return JSON.stringify({
    schemaVersion: 1,
    key: publicEncrypt(
      { key: publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
      key,
    ).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  })
}

export function openBundle(input: unknown, privateKey: string, expected: Identity, now: Date) {
  const envelope = envelopeSchema.parse(input)
  const key = privateDecrypt(
    { key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(envelope.key, 'base64'),
  )
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const payload = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ])
  const bundle = bundleSchema.parse(JSON.parse(payload.toString('utf8')))
  const manifest = assertFreshManifest(bundle.manifest, expected, now)
  const files = Object.fromEntries(
    Object.entries(bundle.files).map(([name, data]) => [name, Buffer.from(data, 'base64')]),
  )
  if (
    !requiredFiles.every((name) => files[name]) ||
    !Object.keys(files).every(validFile) ||
    Object.keys(files).length !== Object.keys(manifest.files).length ||
    Object.entries(files).some(([name, data]) => manifest.files[name] !== sha256(data))
  )
    throw new Error('Deployment artifact integrity failed')
  return { manifest, files }
}
