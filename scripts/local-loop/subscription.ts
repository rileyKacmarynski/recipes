import { z } from 'zod'
import { LoopStop } from './coordinator.ts'
import { activeRoles, modelForRole, type Config } from './contracts.ts'

const integrationsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      connections: z.array(
        z.object({
          type: z.string(),
          method: z.string().optional(),
          status: z.object({ status: z.string() }).optional(),
        }),
      ),
    }),
  ),
})
const routeSchema = z.object({
  package: z.string(),
  settings: z.object({ baseURL: z.string(), apiKey: z.unknown().optional() }),
  headers: z.record(z.string(), z.unknown()).optional(),
})
const rawCatalogSchema = z.object({
  data: z.array(z.object({ id: z.string(), providerID: z.string() }).passthrough()),
})

function assertRoute(raw: unknown) {
  const parsed = routeSchema.safeParse(raw)
  if (!parsed.success)
    throw new LoopStop(
      'setup-failure',
      'Cannot verify the ChatGPT subscription route; no inference authorized',
    )
  const route = parsed.data
  let endpoint: URL
  try {
    endpoint = new URL(route.settings.baseURL)
  } catch {
    throw new LoopStop('setup-failure', 'Invalid ChatGPT subscription endpoint')
  }
  if (
    !['@opencode/ai/providers/openai', '@opencode/ai/providers/openai/responses'].includes(
      route.package,
    ) ||
    endpoint.origin !== 'https://chatgpt.com' ||
    endpoint.username ||
    endpoint.password ||
    route.settings.apiKey !== undefined ||
    Object.keys(route.headers ?? {}).some((key) =>
      ['authorization', 'x-api-key', 'api-key', 'x-openai-key'].includes(key.toLowerCase()),
    )
  )
    throw new LoopStop(
      'setup-failure',
      'ChatGPT subscription mode refuses API-key, custom proxy, or non-ChatGPT routes; no paid fallback',
    )
}

// Read-only metadata preflight. Never copy credential values/provider bodies into evidence.
export function assertChatGptSubscription(
  config: Config,
  integrations: unknown,
  provider: unknown,
  catalog: unknown,
) {
  const parsed = integrationsSchema.safeParse(integrations)
  const connections = parsed.success
    ? parsed.data.data.find((item) => item.id === 'openai')?.connections
    : undefined
  if (
    !connections?.length ||
    connections.some(
      (connection) =>
        connection.type !== 'credential' ||
        connection.method !== 'oauth' ||
        connection.status !== undefined,
    )
  )
    throw new LoopStop(
      'setup-failure',
      'ChatGPT subscription mode requires an OAuth-only OpenAI connection; API-key/environment/ambiguous auth is not authorized',
    )
  assertRoute(z.object({ data: z.unknown() }).parse(provider).data)
  const models = rawCatalogSchema.parse(catalog).data
  for (const role of activeRoles(config)) {
    const selected = modelForRole(config, role)
    if (selected.providerID !== 'openai')
      throw new LoopStop(
        'setup-failure',
        'Only openai/... models are authorized for ChatGPT subscription usage',
      )
    assertRoute(
      models.find((model) => model.providerID === 'openai' && model.id === selected.modelID),
    )
  }
}
