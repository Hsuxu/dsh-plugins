import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../lib/client.js', import.meta.url)
let text = await readFile(path, 'utf8')
const pairs = [
  ['@cocofhu/dsh-aio-agent', 'dsh-cli-bridge'],
  ['plugins.aioAgent', 'plugins.cliBridge'],
  ['aioBinding', 'cliBinding'],
  ['/api/aio-agent/', '/api/cli-bridge/'],
  ['data-aio-', 'data-cli-'],
  ['aio-resume', 'cli-resume'],
  ['aio-agent', 'cli-agent'],
  ['aio-', 'cli-'],
  ['[dsh-aio-agent]', '[dsh-cli-bridge]'],
  ['AIO', 'CLI'],
]
for (const [from, to] of pairs) {
  const count = text.split(from).length - 1
  text = text.split(from).join(to)
  console.log(`${JSON.stringify(from)} -> ${JSON.stringify(to)}: ${count}`)
}
await writeFile(path, text)
const left = [...text.matchAll(/aio/gi)].length
console.log('remaining aio matches:', left)
