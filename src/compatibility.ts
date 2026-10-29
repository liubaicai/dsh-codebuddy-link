/**
 * Compatibility identity for the unofficial read-only CN quota/config protocol.
 * The config service requires a parseable CLI/version UA (otherwise HTTP 400 /
 * code 12403). This is not the installed CLI version. Retain the known wire
 * identity until upstream compatibility is revalidated; do not send credentials
 * to additional endpoints or substitute a generic plugin UA to work around errors.
 */
export const CODEBUDDY_COMPAT_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'
