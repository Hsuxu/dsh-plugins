#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const rawName = process.argv[2]

if (!rawName) {
  console.error('Usage: pnpm new <plugin-name>')
  console.error('Example: pnpm new my-plugin')
  process.exit(1)
}

const name = rawName.replace(/^dsh-/, '')
const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

if (!validName.test(name)) {
  console.error(`Invalid plugin name "${rawName}". Use kebab-case, for example "my-plugin".`)
  process.exit(1)
}

const packageName = `dsh-${name}`
const root = resolve(import.meta.dirname, '..')
const dir = join(root, 'packages', name)

if (existsSync(dir)) {
  console.error(`Plugin directory already exists: packages/${name}`)
  process.exit(1)
}

mkdirSync(join(dir, 'lib'), { recursive: true })

writeFileSync(
  join(dir, 'package.json'),
  `${JSON.stringify(
    {
      name: packageName,
      version: '0.1.0',
      private: true,
      description: 'A DeepSeek Harness plugin.',
      type: 'module',
      main: 'lib/index.js',
      exports: {
        '.': './lib/index.js',
        './package.json': './package.json',
      },
      files: ['lib', 'cordis.patch.yml', 'README.md'],
      dsh: {
        bundle: {
          patch: './cordis.patch.yml',
        },
      },
      engines: {
        node: '>=22',
        dsh: '>=0.2.0',
      },
    },
    null,
    2,
  )}\n`,
)

writeFileSync(
  join(dir, 'cordis.patch.yml'),
  `- insert:\n    - id: ${name}\n      name: ${packageName}\n`,
)

writeFileSync(
  join(dir, 'lib', 'index.js'),
  `export const name = '${packageName}'\n\nexport function apply(ctx) {\n  // Register services, tools, commands, or UI resources here.\n  void ctx\n}\n`,
)

writeFileSync(
  join(dir, 'README.md'),
  `# ${packageName}\n\nDescribe what this plugin adds and how to configure it.\n\n## Install\n\nFrom this repository checkout:\n\n\`\`\`sh\ndsh plugin --profile web add link:./packages/${name}\n\`\`\`\n\n## Configuration\n\nDocument every config key, its default, and the environment variables it reads.\n`,
)

console.log(`Created packages/${name}`)
console.log('')
console.log('Next steps:')
console.log(`  1. Implement the plugin in packages/${name}/lib/index.js`)
console.log(`  2. Add a row for ${packageName} to the README plugin table`)
console.log('  3. Run pnpm check')
