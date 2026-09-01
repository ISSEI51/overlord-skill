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
 * port (`ghe.example.com:8443`), which is stripped from the last colon so an
 * `[::1]` keeps its own: a port does not change whose host it is.
 *
 * `host` and `protocol` are compared without regard to case, because git
 * passes both through from the remote URL exactly as it is written there:
 * `https://GitHub.com/o/r.git` produces `host=GitHub.com`, and
 * `HTTPS://…` produces `protocol=HTTPS`. Every other host comparison in this
 * module folds case (`httpsHostOf`, `githubHost`), so a remote written that
 * way passes `pushIdentity` and reaches this helper; a case-sensitive
 * comparison here would refuse it and break the push.
 */
const CREDENTIAL_HELPER =
  `!f() { ` +
  `[ "$1" = get ] || return 0; ` +
  `[ -n "$${CREDENTIAL_HOST_ENV}" ] || return 0; ` +
  `h=; p=; ` +
  `while IFS='=' read -r k v; do ` +
  `[ -n "$k" ] || break; ` +
  `case "$k" in host) h=$v ;; protocol) p=$v ;; esac; ` +
  `done; ` +
  `lc() { printf '%s' "$1" | LC_ALL=C tr 'A-Z' 'a-z'; }; ` +
  `[ "$(lc "$p")" = https ] || return 0; ` +
  `[ "$(lc "\${h%:*}")" = "$${CREDENTIAL_HOST_ENV}" ] || return 0; ` +
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
      // only source. `gh` treats an empty value as unset. All four, because
      // which pair `gh` reads depends on the host it is targeting.
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
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
 * Whether `gh` reads the Enterprise Server token variables for `host`.
 *
 * `gh help environment` (gh 2.89.0) defines the split: `GH_TOKEN` and
 * `GITHUB_TOKEN` are used "when a command targets either github.com or a
 * subdomain of ghe.com", and `GH_ENTERPRISE_TOKEN` and
 * `GITHUB_ENTERPRISE_TOKEN` "when a command targets a GitHub Enterprise Server
 * host". Everything that is not github.com and not a `ghe.com` subdomain is
 * therefore an Enterprise Server host as far as `gh` is concerned.
 *
 * Measured on gh 2.89.0: with `GH_HOST=ghe.example.com` and `GH_TOKEN` set,
 * `gh auth status` reports that host as authenticated by `(default)` — the
 * stored credential — and names `(GH_TOKEN)` only for github.com.
 */
function isEnterpriseServerHost(host: string): boolean {
  return host !== "github.com" && !host.endsWith(".ghe.com");
}

/**
 * Environment that makes one `gh` call run as the agent account.
 *
 * `GH_TOKEN` takes precedence over every other source `gh` consults, including
 * the active keyring account. On a GitHub Enterprise Server host `gh` does not
 * read it at all, so the token also goes into `GH_ENTERPRISE_TOKEN` there;
 * without that, `gh` falls back to the stored credential, which is the user's,
 * and `gh pr create` opens the pull request under their name — the one
 * substitution this module exists to prevent, happening silently.
 *
 * `GITHUB_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` are emptied because `gh` also
 * honours them and an inherited one would otherwise decide which account is
 * used if the variable ahead of it were ever dropped. `gh` treats an empty
 * value as unset.
 *
 * `GH_ENTERPRISE_TOKEN` is emptied rather than set when the account belongs to
 * github.com: a token for one host is not offered to another, which is the
 * same rule the git credential helper follows.
 */
export function ghEnvFor(
  resolution: IdentityResolution,
): Record<string, string> | undefined {
  if (resolution.status !== "resolved") return undefined;
  const { token } = resolution.identity;
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: isEnterpriseServerHost(githubHost()) ? token : "",
    GITHUB_ENTERPRISE_TOKEN: "",
  };
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
 * Why a push to `url` must not be made at all, or null when it may be.
 *
 * An HTTPS remote on a host the agent account does not own is the one case
 * that is refused rather than reported. The token is not sent there — a token
 * for one host must never be handed to another — but git does not stop at
 * that: it asks the next credential helper, which on a developer's machine is
 * the macOS keychain or the one `gh auth setup-git` installed, and both answer
 * with the user's own account. The push would then succeed under the user's
 * name, which is the substitution the separate account exists to prevent, and
 * it would succeed quietly: a warning on stderr is not a thing anyone reads
 * after the pull request is already open under the wrong name.
 *
 * A non-HTTPS remote (ssh, or a local path) is not refused; see
 * `pushAttributionWarning`. The two are different because of who ends up
 * owning the push: over ssh there is no credential to substitute — the key of
 * the machine is the only thing that can authenticate, on a repository that is
 * otherwise configured correctly and working — while over HTTPS to a foreign
 * host there is a credential, and it is the user's.
 *
 * This costs nothing when nothing is configured: with no agent account,
 * `pushIdentity` never asks.
 */
export function pushAttributionRefusal(
  identity: AgentIdentity,
  url: string,
): string | null {
  const host = httpsHostOf(url);
  const expected = githubHost();
  if (host === null || host === expected) return null;
  const who = identity.account ?? `the token in $${AGENT_TOKEN_ENV}`;
  return (
    `the push remote is "${url}", on "${host}" rather than "${expected}", ` +
    `where ${who} is. The agent account's token is not sent to another host, ` +
    `so this push would be authenticated by whatever credential this machine ` +
    `has for "${host}" — the user's — and the branch and its pull request ` +
    `would be attributed to them. Nothing was pushed. Point origin at ` +
    `https://${expected}/<owner>/<repo>.git, or set GH_HOST to the host the ` +
    `agent account belongs to.`
  );
}

/**
 * Why a push to `url` cannot be attributed to the agent account, or null when
 * it can.
 *
 * Reported rather than enforced: a repository on an SSH remote still works,
 * and refusing to push at all would be a worse answer than pushing under the
 * key that is configured and saying so. An HTTPS remote on another host is
 * refused instead of reported, by `pushAttributionRefusal`; this function
 * still describes it, for `identity`, which reports every reason it finds
 * rather than performing a push.
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
