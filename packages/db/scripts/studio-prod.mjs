import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const prodAccountId = '699281550169'
const clusterIdentifier = 'recipes-prod-database'
const databaseName = 'recipes'

const options = parseArgs(process.argv.slice(2))
const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1'
const awsEnv = {
  ...process.env,
  AWS_REGION: region,
  ...(options.profile ? { AWS_PROFILE: options.profile } : {}),
}

const identity = JSON.parse(await aws(['sts', 'get-caller-identity', '--output', 'json'], awsEnv))

if (identity.Account !== prodAccountId) {
  throw new Error(
    `Refusing to open prod Studio with AWS account ${identity.Account}; expected ${prodAccountId}`,
  )
}

const cluster = JSON.parse(
  await aws(
    [
      'rds',
      'describe-db-clusters',
      '--db-cluster-identifier',
      clusterIdentifier,
      '--output',
      'json',
    ],
    awsEnv,
  ),
).DBClusters?.[0]

const resourceArn = cluster?.DBClusterArn
const secretArn = cluster?.MasterUserSecret?.SecretArn

if (!resourceArn || !secretArn) {
  throw new Error(`Could not resolve Aurora Data API ARNs for ${clusterIdentifier}`)
}

await wakeDatabase({ awsEnv, resourceArn, secretArn })

console.log(`Opening Drizzle Studio for ${clusterIdentifier} in ${region}`)

await spawnInteractive('pnpm', ['exec', 'drizzle-kit', 'studio', '--config', 'drizzle.config.ts'], {
  ...process.env,
  AWS_REGION: region,
  ...(options.profile ? { AWS_PROFILE: options.profile } : {}),
  DATABASE_DRIVER: 'data-api',
  DATABASE_NAME: databaseName,
  DATABASE_RESOURCE_ARN: resourceArn,
  DATABASE_SECRET_ARN: secretArn,
})

async function wakeDatabase({ awsEnv, resourceArn, secretArn }) {
  const delaysMs = [0, 2_000, 5_000, 10_000, 10_000, 10_000]

  for (const [attempt, delayMs] of delaysMs.entries()) {
    if (delayMs > 0) {
      await delay(delayMs)
    }

    try {
      await aws(
        [
          'rds-data',
          'execute-statement',
          '--resource-arn',
          resourceArn,
          '--secret-arn',
          secretArn,
          '--database',
          databaseName,
          '--sql',
          'select 1',
          '--output',
          'json',
        ],
        awsEnv,
      )
      return
    } catch (error) {
      if (!String(error.message).includes('DatabaseResumingException')) {
        throw error
      }

      console.warn(`Aurora is resuming; retrying wake query attempt ${attempt + 1}`)
    }
  }

  throw new Error('Aurora did not finish resuming before Drizzle Studio startup')
}

function aws(args, env) {
  return spawnCapture('aws', ['--region', region, ...args], env)
}

function spawnCapture(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`))
    })
  })
}

function spawnInteractive(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageDir,
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }

      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

function parseArgs(args) {
  const parsed = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--') {
      continue
    }

    if (arg === '--profile') {
      parsed.profile = requiredArg(args, index, '--profile')
      index += 1
      continue
    }

    if (arg === '--region') {
      parsed.region = requiredArg(args, index, '--region')
      index += 1
      continue
    }

    if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm db:studio:prod -- --profile <aws-profile> [--region us-east-1]')
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return parsed
}

function requiredArg(args, index, name) {
  const value = args[index + 1]

  if (!value) {
    throw new Error(`Missing value for ${name}`)
  }

  return value
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
