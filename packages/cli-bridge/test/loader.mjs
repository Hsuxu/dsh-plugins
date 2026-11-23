import { register } from 'node:module'

// Resolve DSH's runtime packages to the small doubles in test/stubs, so the
// pure modules can be tested without a running Harness.
register('./hooks.mjs', import.meta.url)
