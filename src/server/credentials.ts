import { existsSync } from "fs"
import { mkdir, readFile, writeFile, unlink } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { type ServerMetadata, type TokenEndpointResponse } from "../types.js"

const dirName = path.dirname(fileURLToPath(import.meta.url))
const pluginDirectoryName = "com.kick-streamer-watch.sdPlugin"
const repoRoot = path.resolve(dirName, "../../")

const defaultSourcePath = path.join(repoRoot, "credentials.json")

let cachedCredentialsPath: string | undefined

export type Credentials = {
  serverMetadata: ServerMetadata,
  clientId: string;
  clientSecret: string;
  tokens: TokenEndpointResponse;
}

function resolvePluginRoot(): string {
  const cwd = process.cwd()
  if (path.basename(cwd) === pluginDirectoryName) {
    return cwd
  }

  return path.resolve(cwd, pluginDirectoryName)
}

function getCandidatePaths(): string[] {
  const cwd = process.cwd()
  const pluginRoot = resolvePluginRoot()

  const possiblePaths = [
    defaultSourcePath,
    path.join(pluginRoot, "credentials.json"),
    path.resolve(cwd, "credentials.json"),
  ]

  if (cachedCredentialsPath) {
    possiblePaths.push(path.normalize(cachedCredentialsPath))
  }

  return Array.from(new Set(possiblePaths.map(path.normalize)))
}

function getWriteTargets(): string[] {
  const pluginRoot = resolvePluginRoot()
  const targets = [
    defaultSourcePath,
    path.join(pluginRoot, "credentials.json"),
  ]

  if (cachedCredentialsPath) {
    targets.push(path.normalize(cachedCredentialsPath))
  }

  return Array.from(new Set(targets.map(path.normalize)))
}

async function persistToTargets(payload: string): Promise<string> {
  const targets = getWriteTargets()
  const successful: string[] = []

  for (const target of targets) {
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, payload)
      successful.push(target)
    } catch (_error) {
      // Ignore write failures on secondary paths but continue attempting others.
      continue
    }
  }

  if (successful.length === 0) {
    throw new Error("Failed to persist Kick credentials to disk.")
  }

  cachedCredentialsPath = successful[0]
  return successful[0]
}

export async function writeCredentials(
  serverMetadata: ServerMetadata,
  clientId: string,
  clientSecret: string,
  tokens: TokenEndpointResponse,
) {
  const credentials: Credentials = {
    serverMetadata,
    clientId,
    clientSecret,
    tokens
  }

  const payload = JSON.stringify(credentials, undefined, 2)
  return persistToTargets(payload)
}

export async function readCredentials() {
  const locations = getCandidatePaths()

  for (const candidate of locations) {
    if (!existsSync(candidate)) {
      continue
    }

    const contents = await readFile(candidate)
    cachedCredentialsPath = candidate
    return JSON.parse(contents.toString()) as Credentials
  }

  throw new Error("Kick credentials not found. Run the auth helper to generate credentials.json.")
}

export async function deleteCredentials() {
  const targets = getWriteTargets()
  for (const target of targets) {
    if (existsSync(target)) {
      try {
        await unlink(target)
      } catch (e) {
        console.warn(`Failed to delete credentials at ${target}`, e)
      }
    }
  }
  cachedCredentialsPath = undefined
}