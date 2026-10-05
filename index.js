/**
 * Host half of dsh-plugin-composer-expand.
 *
 * The plugin is browser-only: it is an expand button in the composer, a
 * stylesheet, and one keydown interception. The host half exists because every
 * profile row needs a Node-side module; a no-op is legitimate (the shipped
 * `dsh-client-ui-sidebar` and the sibling `dsh-plugin-composer-align` do the
 * same).
 */

/** @type {string[]} No Cordis services are required. */
export const inject = [];

/**
 * Host plugin body.
 * @param ctx - Cordis context (unused).
 */
export function apply(ctx) {}
