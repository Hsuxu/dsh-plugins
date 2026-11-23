/** DSH provider route that lists one backend's models in the native model picker. */
export const providerId = (backendId) => `cli-${backendId}`

/** Backend id of a cli provider route, or undefined for any other provider. */
export const backendOfProvider = (provider) => (typeof provider === 'string' && provider.startsWith('cli-') ? provider.slice(4) : undefined)
