export function sandboxCommand(
  command: string,
  args: string[],
  options: {
    readable: string[]
    writable: string[]
    hidden?: string[]
    databasePort?: number
    listen?: boolean
  },
): [string, string[]]
export function cleanEnvironment(scratch: string): Record<string, string>
export function validateSandbox(
  directory: string,
): Promise<{ platform: string; checkedAt: string; probes: string[] }>
