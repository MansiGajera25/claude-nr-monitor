// GitHub login for one project: use the project's own token (GITHUB_TOKEN in envs/<app>.env)
// instead of the server's default `gh auth login`. Used for client repos where only a developer has access.

/**
 * Environment variables that make git and gh use this token. The token is passed through
 * environment variables only, so it never appears in a command line, a URL or the clone's .git/config.
 * Returns {} when there is no token (git and gh then use the server's default login).
 */
export function githubEnv(token) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GH_TOKEN: token, // gh (pull requests) uses this before its stored login
    GIT_TERMINAL_PROMPT: '0', // fail instead of waiting for a password
    // git ≥ 2.31 reads extra settings from GIT_CONFIG_* variables:
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper', // empty value = ignore the server's stored GitHub login
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Replaces the token (and its base64 form) in a text, so it can be logged safely. */
export function hideToken(text, token) {
  if (!token) return text;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return String(text).split(token).join('<token>').split(basic).join('<token>');
}
