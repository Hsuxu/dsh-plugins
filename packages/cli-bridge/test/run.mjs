// The sandbox forbids spawning the per-file test workers, so run every suite in
// this process; node:test still reports each test and sets the exit code.
import './backends.test.js'
import './catalog.test.js'
import './commands.test.js'
import './plan.test.js'
import './process.test.js'
import './quota.test.js'
import './sessions.test.js'
import './streams.test.js'
import './turn-writer.test.js'
