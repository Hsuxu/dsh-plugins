#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packagesDir = join(root, 'packages')
const errors = []
const plugins = []
const names = new Map()

if (!existsSync(packagesDir)) {
  errors.push('packages/ does not exist')
} else {
  const entries = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()

  for (const dirName of entries) {
    const dir = join(packagesDir, dirName)
    const manifestPath = join(dir, 'package.json')

    if (!existsSync(manifestPath)) {
      errors.push(`packages/${dirName}: missing package.json`)
      continue
    }

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      errors.push(`packages/${dirName}: invalid package.json (${error.message})`)
      continue
    }

    const packageName = manifest.name
    if (typeof packageName !== 'string' || packageName.length === 0) {
      errors.push(`packages/${dirName}: package.json is missing "name"`)
    } else if (names.has(packageName)) {
      errors.push(`packages/${dirName}: duplicate package name "${packageName}" (also used by packages/${names.get(packageName)})`)
    } else {
      names.set(packageName, dirName)
    }

    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string' || patch.length === 0) {
      errors.push(`packages/${dirName}: package.json is missing "dsh.bundle.patch"`)
    } else {
      const patchPath = join(dir, patch)
      if (!existsSync(patchPath) || !statSync(patchPath).isFile()) {
        errors.push(`packages/${dirName}: "dsh.bundle.patch" points to missing file ${patch}`)
      }
    }

    const main = manifest.main
    if (typeof main !== 'string' || main.length === 0) {
      errors.push(`packages/${dirName}: package.json is missing "main"`)
    } else {
      const mainPath = join(dir, main)
      if (!existsSync(mainPath) || !statSync(mainPath).isFile()) {
        errors.push(`packages/${dirName}: "main" points to missing file ${main}`)
      }
    }

    if (!existsSync(join(dir, 'README.md'))) {
      errors.push(`packages/${dirName}: missing README.md`)
    }

    plugins.push({
      packageName: packageName ?? '(unnamed)',
      dir: `packages/${dirName}`,
      version: manifest.version ?? '0.0.0',
      description: manifest.description ?? '',
    })
  }
}

const workspacePath = join(root, 'pnpm-workspace.yaml')
if (!existsSync(workspacePath)) {
  errors.push('pnpm-workspace.yaml is missing')
} else if (!readFileSync(workspacePath, 'utf8').includes('packages/*')) {
  errors.push('pnpm-workspace.yaml must include "packages/*"')
}

if (plugins.length > 0) {
  console.log('Plugins:')
  for (const plugin of plugins) {
    console.log(`  ${plugin.packageName}@${plugin.version}  ${plugin.dir}`)
  }
} else {
  console.log('Plugins: none yet. Run "pnpm new <plugin-name>" to create one.')
}

if (errors.length > 0) {
  console.error('')
  console.error('Workspace check failed:')
  for (const error of errors) {
    console.error(`  - ${error}`)
  }
  process.exit(1)
}

console.log('')
console.log('Workspace check passed.')
