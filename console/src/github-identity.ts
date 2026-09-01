/**
 * The GitHub account Overlord acts as.
 *
 * Every branch Overlord pushes and every pull request it opens is a machine
 * action, and GitHub attributes both to whoever owns the credential that
 * performed them. Left alone, that is the person who logged `gh` in, so the
 * agent's work and the user's work are indistinguishable on GitHub — and, more
 * importantly, a pull request GitHub believes the user opened is a pull request
 * the user cannot approve. A repository whose default branch requires one
 * approval and grants no bypass therefore depends on the pull request being
 * opened by somebody other than the reviewer.
 *
 * So Overlord runs those two operations under a separate account:
 *
 *   OVERLORD_GH_ACCOUNT=ISSEI-BOT
 *
 * The name is a `gh` account — one of the accounts `gh auth status` lists — and
 * the token is read from `gh auth token --user <name>` at the moment it is
 * needed. The active `gh` account is never switched: `gh auth switch` is
 * process-wide and permanent, so two Overlord sessions running at once would
 * fight over it, and a failure would leave the user's shell logged in as the
 * bot. The token is handed to each command through its environment instead,
 * which is per-command and disappears with the process.
 *
 * `OVERLORD_GH_TOKEN` sets the token directly, for a machine where the
 * account is not in the `gh` keyring at all.
 *
 * With neither set, nothing changes: the commands run under the active `gh`
 * account exactly as they did before. With one of them set but unusable, the
 * commands fail rather than falling back to the user's account, because a
 * silent fallback is precisely the outcome the separation exists to prevent.
 */

import { run } from "./run.ts";

/** Environment variable naming the `gh` account to act as. */
export const AGENT_ACCOUNT_ENV = "OVERLORD_GH_ACCOUNT";

/** Environment variable carrying the agent account's token directly. */
export const AGENT_TOKEN_ENV = "OVERLORD_GH_TOKEN";

/**
 * Environment variables the git credential helper below reads.
 *
 * They exist so the token never appears in an argument vector. `git -c
 * http.extraheader=...` and a token in the remote URL both put it on the
 * command line, where any process on the machine can read it out of `ps`.
 */
export const CREDENTIAL_USERNAME_ENV = "OVERLORD_GIT_CREDENTIAL_USERNAME";
export const CREDENTIAL_TOKEN_ENV = "OVERLORD_GIT_CREDENTIAL_TOKEN";

/**
 * The only host the helper answers for.
 *
 * It is here rather than baked into the helper text so that the helper stays
 * one constant, and so that `GH_HOST` decides it the same way it decides every
 * other host question in this module.
 */
export const CREDENTIAL_HOST_ENV = "OVERLORD_GIT_CREDENTIAL_HOST";

/**
 * Username sent with the token over HTTPS.
 *
 * GitHub authenticates the token and ignores the username, so this is only a
 * label. It is the conventional one for a token used as a password.
 */
const CREDENTIAL_USERNAME = "x-access-token";

/**
 * A git credential helper that answers from the environment, for one host.
 *
 * Git runs a helper whose value starts with `!` through `sh -c`, appending the
 * operation, so `$1` is `get`, `store` or `erase`. Only `get` is answered:
 * `store` must stay a no-op, or the agent's token would be written into the
 * user's macOS keychain, where every later push — including the user's own —
 * would pick it up. Every path returns 0, because a non-zero helper makes git
 * report an error for an operation that was fine.
 *
 * A `get` is answered only when the request git wrote on stdin names
 * `$OVERLORD_GIT_CREDENTIAL_HOST` over https. `pushIdentity` already checks
 * the push remote before installing this helper, so that check is what
 * normally keeps the token on its own host; this one closes the paths that
 * check cannot see, where a single `git push` asks for a credential for
 * somewhere else — an authenticated `http.proxy`, or a redirect to another
 * host — and the helper, having no opinion about the host, handed over the
 * agent account's token. Failing to answer is the safe direction: git reports
 * that it has no credential for that host, which is true.
 *
 * The request is `key=value` lines terminated by a blank line, so `IFS='='`
 * splits each one and the value keeps any further `=`. A `host` may carry a
 * port (`ghe.example.com:8443`), which is stripped: a port does not change
 * whose host it is.
 */
const CREDENTIAL_HELPER =
  `!f() { ` +
  `[ "$1" = get ] || return 0; ` +
  `h=; p=; ` +
  `while IFS='=' read -r k v; do ` +
  `[ -n "$k" ] || break; ` +
  `case "$k" in host) h=$v ;; protocol) p=$v ;; esac; ` +
  `done; ` +
  `[ "$p" = https ] || return 0; ` +
  `[ "\${h%%:*}" = "$${CREDENTIAL_HOST_ENV}" ] || return 0; ` +
  `printf 'username=%s\\npassword=%s\\n' ` +
  `"$${CREDENTIAL_USERNAME_ENV}" "$${CREDENTIAL_TOKEN_ENV}"; ` +
  `}; f`;

/** The agent account, once it has been resolved to a usable token. */
export type AgentIdentity = {
  /** The `gh` account name, or null when only a token was configured. */
  account: string | null;
  /** The token every `gh` call and every push is authenticated with. */
  token: string;
  /** Where the token came from, for the diagnostics. */
  source: string;
};

/**
 * The three answers to "which account does Overlord act as here?".
 *
 * `unconfigured` is the pre-existing behaviour and is not an error. `failed`
 * is: the user asked for an account and it could not be produced, and running
 * as somebody else instead would be the wrong repair.
 */
export type IdentityResolution =
  | { status: "unconfigured" }
  | { status: "resolved"; identity: AgentIdentity }
  | { status: "failed"; reason: string };

/** The last successful resolution, keyed by the configuration that produced it. */
let cached: { key: string; identity: AgentIdentity } | null = null;

/** Value of an environment variable, with blanks treated as unset. */
function configured(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Forget the cached token. Exists for the tests, which change the environment. */
export function resetAgentIdentityCache(): void {
  cached = null;
}

/**
 * Resolve the account Overlord acts as.
 *
 * A success is cached for the life of the process, because every `gh` call
 * goes through here and `gh auth token` is a subprocess of its own. The cache
 * key is the configuration that produced it, so changing the environment
 * resolves again. A failure is not cached: it is usually something the user
 * fixes while the console server keeps running.
 */
export async function agentIdentity(): Promise<IdentityResolution> {
  const account = configured(AGENT_ACCOUNT_ENV);
  const token = configured(AGENT_TOKEN_ENV);
  if (account === null && token === null) return { status: "unconfigured" };

  const key = `${account ?? ""}\0${token ?? ""}`;
  if (cached && cached.key === key) {
    return { status: "resolved", identity: cached.identity };
  }

  let identity: AgentIdentity;
  if (token !== null) {
    identity = { account, token, source: `$${AGENT_TOKEN_ENV}` };
  } else {
    const command = ["gh", "auth", "token", "--user", account!];
    const read = await run(command, undefined, undefined, {
      // `gh auth token` reports the token in the environment when there is
      // one, which here would be a token left over from an outer Overlord run
      // and not the account that was asked for. Emptied so the keyring is the
      // only source. `gh` treats an empty value as unset.
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    });
    if (read.code !== 0 || read.stdout.trim() === "") {
      return {
        status: "failed",
        reason:
          `${AGENT_ACCOUNT_ENV}=${account} is set, but ` +
          `${command.join(" ")} produced no token: ` +
          (read.stderr.trim() || read.stdout.trim() || `exit ${read.code}`) +
          `\nRun "gh auth status" to see which accounts are logged in, or ` +
          `set ${AGENT_TOKEN_ENV} to the token directly.`,
      };
    }
    identity = {
      account,
      token: read.stdout.trim(),
      source: `gh auth token --user ${account}`,
    };
  }

  cached = { key, identity };
  return { status: "resolved", identity };
}

/**
 * Environment that makes one `gh` call run as the agent account.
 *
 * `GH_TOKEN` takes precedence over every other source `gh` consults, including
 * the active keyring account, so this needs no other setting. `GITHUB_TOKEN` is
 * emptied because `gh` also honours it and an inherited one would otherwise
 * decide which account is used when `GH_TOKEN` were ever dropped.
 */
export function ghEnvFor(
  resolution: IdentityResolution,
): Record<string, string> | undefined {
  if (resolution.status !== "resolved") return undefined;
  return { GH_TOKEN: resolution.identity.token, GITHUB_TOKEN: "" };
}

/**
 * `git -c` arguments that authenticate one command as the agent account.
 *
 * The empty value first clears every helper the configuration files already
 * contributed — the macOS keychain, `credential.store`, and the
 * `credential.https://github.com.helper` that `gh auth setup-git` installs —
 * because helpers are consulted in configuration order and the first one to
 * answer wins, which would be the user's account. Command-line `-c` is read
 * last, so the reset reaches all of them.
 */
export function pushCredentialArgs(): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${CREDENTIAL_HELPER}`,
  ];
}

/**
 * Environment carrying the credential the helper above prints, and the one
 * host it prints it for.
 *
 * The host is `githubHost()`, which is the host the agent account's token
 * belongs to and, by the time `pushIdentity` installs the helper, the host of
 * the push remote as well.
 */
export function pushCredentialEnv(
  identity: AgentIdentity,
): Record<string, string> {
  return {
    [CREDENTIAL_USERNAME_ENV]: CREDENTIAL_USERNAME,
    [CREDENTIAL_TOKEN_ENV]: identity.token,
    [CREDENTIAL_HOST_ENV]: githubHost(),
    // The helper answers for the host the push goes to, so a prompt here means
    // either that the token was rejected or that something asked for a
    // credential for another host. Without this, git would ask on the terminal
    // and the command would hang or fail with a confusing error instead of
    // reporting it.
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** How the agent account is named in the output. */
export function describeAccount(identity: AgentIdentity): string {
  return identity.account ?? `the token in $${AGENT_TOKEN_ENV}`;
}

/** What to tell a user who has not configured an agent account. */
export function unconfiguredHint(): string[] {
  return [
    `No agent account is configured, so branches are pushed and pull ` +
      `requests are opened under the active gh account.`,
    `Set ${AGENT_ACCOUNT_ENV} to the gh account Overlord should act as, for ` +
      `every project:`,
    ``,
    `    echo 'export ${AGENT_ACCOUNT_ENV}=<account>' >> ~/.zshrc`,
    ``,
    `The account must be logged in ("gh auth status" lists it) and must be a ` +
      `collaborator with write access on each repository Overlord is used in.`,
  ];
}

/** The host whose credentials the agent account owns. */
export function githubHost(): string {
  return (configured("GH_HOST") ?? "github.com").toLowerCase();
}

/**
 * Host of an HTTPS remote URL, or null when the URL is not HTTPS.
 *
 * SSH remotes (`git@github.com:owner/repo.git`) authenticate with a key rather
 * than a credential helper, so no token can be injected into them and the push
 * is attributed to whoever owns the key.
 */
export function httpsHostOf(url: string): string | null {
  if (!/^https:\/\//i.test(url.trim())) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Why a push to `url` cannot be attributed to the agent account, or null when
 * it can.
 *
 * Reported rather than enforced: a repository on an SSH remote still works,
 * and refusing to push at all would be a worse answer than pushing under the
 * key that is configured and saying so.
 */
export function pushAttributionWarning(
  identity: AgentIdentity,
  url: string,
): string | null {
  const host = httpsHostOf(url);
  const expected = githubHost();
  const who = identity.account ?? `the token in $${AGENT_TOKEN_ENV}`;
  if (host === null) {
    return (
      `the push remote is "${url}", which is not an HTTPS URL, so the push ` +
      `is authenticated with the SSH key of this machine and not with ` +
      `${who}. Change the remote to https://${expected}/<owner>/<repo>.git ` +
      `for the push to be attributed to the agent account.`
    );
  }
  if (host !== expected) {
    return (
      `the push remote is on "${host}", not "${expected}", so the agent ` +
      `account's token is not sent to it and the push is not attributed to ` +
      `${who}.`
    );
  }
  return null;
}
