const ALLOWED_ENVIRONMENT_KEYS = [
  'HOME',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'USER',
  'LOGNAME',
  'CODEX_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR'
] as const

export function codexProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  return environment
}
