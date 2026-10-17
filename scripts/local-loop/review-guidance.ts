import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { reviewSchema, type Role } from './contracts.ts'

// Fixed references: no model-selected skill paths, recursive discovery or scheduling.
export const reviewGuidanceFiles = {
  'code-review': [
    '.agents/skills/adversarial-code-review/SKILL.md',
    '.agents/skills/code-review/REVIEW-GUIDANCE.md',
  ],
  'security-review': ['.agents/skills/security-review/SKILL.md'],
  'architecture-review': [
    '.agents/skills/architecture-review/SKILL.md',
    '.agents/skills/architecture-preferences/SKILL.md',
    '.agents/skills/codebase-design/SKILL.md',
  ],
} as const satisfies Partial<Record<Role, readonly string[]>>

export type ReviewGuidance = Record<keyof typeof reviewGuidanceFiles, Record<string, string>>

export function createReviewHandoff(
  role: keyof ReviewGuidance,
  guidance: ReviewGuidance | undefined,
) {
  const references = guidance?.[role]
  if (!references || reviewGuidanceFiles[role].some((path) => !references[path]?.trim()))
    throw new Error(`Missing review guidance for ${role}`)
  return {
    roleInstructions: `You are an independent ${role}. Apply the supplied reviewGuidance and applicable repo ADRs to the approved contract and source/evidence packet. Review only the approved task's candidate behavior; the coordinator owns run authorization and infrastructure checks. Review loop internals only if the approved task explicitly changes or audits them, not merely because loop ADRs or context are supplied. This is a pre-UAT gate; build/UAT evidence is evaluated later. Return ONLY JSON matching outputSchema. Tools are unavailable; use the supplied evidence.`,
    reviewGuidance: references,
    outputSchema: z.toJSONSchema(reviewSchema),
  }
}

export async function loadReviewGuidance(root: string) {
  const adrPaths = (await readdir(resolve(root, 'doc/adr')))
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
    .map((name) => `doc/adr/${name}`)
  if (!adrPaths.length) throw new Error('Review guidance requires the repo ADRs in doc/adr/')
  const paths = [...new Set([...Object.values(reviewGuidanceFiles).flat(), ...adrPaths])]
  const files: Record<string, string> = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(resolve(root, path), 'utf8')
        if (!content.trim()) throw new Error(`Review guidance is empty: ${path}`)
        return [path, content] as const
      }),
    ),
  )
  const byRole = Object.fromEntries(
    Object.entries(reviewGuidanceFiles).map(([role, references]) => [
      role,
      Object.fromEntries(references.map((path) => [path, files[path]!])),
    ]),
  ) as ReviewGuidance
  const adrs = Object.fromEntries(adrPaths.map((path) => [path, files[path]!]))
  return { files, byRole, adrs }
}
