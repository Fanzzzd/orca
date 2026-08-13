import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export const SKILL_FILE_NAME = 'SKILL.md'
export const MAX_SKILL_PACKAGE_FILES = 200
// Why: `fileCount` is a display number, so the walk that produces it must not be
// able to cost more than the walk that found the skill. A package deeper than this
// under-reports its size; it never hides the skill.
export const MAX_SKILL_PACKAGE_DEPTH = 6

function isWithinDepth(rootPath: string, childPath: string, maxDepth: number): boolean {
  const rel = relative(rootPath, childPath)
  if (!rel) {
    return true
  }
  // Why: `..cache` is a valid child name; only a real parent traversal escapes.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  return rel.split(sep).length <= maxDepth
}

async function readEntries(dirPath: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dirPath, { withFileTypes: true })
  } catch {
    return null
  }
}

export async function findSkillFiles(rootPath: string, maxDepth: number): Promise<string[]> {
  const out: string[] = []
  const visitedDirectoryPaths = new Set<string>()
  async function visit(dirPath: string): Promise<void> {
    if (!isWithinDepth(rootPath, dirPath, maxDepth)) {
      return
    }
    let resolvedDirPath: string
    try {
      resolvedDirPath = await realpath(dirPath)
    } catch {
      return
    }
    if (visitedDirectoryPaths.has(resolvedDirPath)) {
      return
    }
    visitedDirectoryPaths.add(resolvedDirPath)

    const entries = await readEntries(dirPath)
    if (!entries) {
      return
    }
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name)
      if (entry.name === SKILL_FILE_NAME) {
        if (entry.isFile()) {
          out.push(entryPath)
          continue
        }
        if (entry.isSymbolicLink()) {
          try {
            if ((await stat(entryPath)).isFile()) {
              out.push(entryPath)
            }
          } catch {
            // Broken links are not valid skill files.
          }
        }
        continue
      }
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      if (entry.isSymbolicLink()) {
        // Why: users commonly symlink agent skill dirs across providers; follow
        // directory links but guard by realpath so recursive links cannot loop.
        try {
          if ((await stat(entryPath)).isDirectory()) {
            await visit(entryPath)
          }
        } catch {
          // Broken links are not valid skill directories.
        }
      }
    }
  }
  await visit(rootPath)
  return out
}

/**
 * Files in a skill package, for the picker's size column. Bounded by count and
 * depth, and `node_modules` is pruned the way the plugin cache scan prunes it —
 * vendored dependencies are payload, not part of the skill.
 */
export async function countPackageFiles(dirPath: string): Promise<number> {
  let count = 0
  const visitedDirectoryPaths = new Set<string>()
  async function visit(currentPath: string, depth: number): Promise<void> {
    if (count >= MAX_SKILL_PACKAGE_FILES || depth > MAX_SKILL_PACKAGE_DEPTH) {
      return
    }
    let resolvedPath: string
    try {
      resolvedPath = await realpath(currentPath)
    } catch {
      return
    }
    if (visitedDirectoryPaths.has(resolvedPath)) {
      return
    }
    visitedDirectoryPaths.add(resolvedPath)

    const entries = await readEntries(currentPath)
    if (!entries) {
      return
    }
    for (const entry of entries) {
      if (count >= MAX_SKILL_PACKAGE_FILES) {
        return
      }
      if (entry.name === 'node_modules') {
        continue
      }
      const entryPath = join(currentPath, entry.name)
      if (entry.isFile()) {
        count += 1
      } else if (entry.isDirectory()) {
        await visit(entryPath, depth + 1)
      } else if (entry.isSymbolicLink()) {
        try {
          if ((await stat(entryPath)).isFile()) {
            count += 1
          }
        } catch {
          // Broken links do not contribute to the skill package file count.
        }
      }
    }
  }
  await visit(dirPath, 0)
  return count
}
