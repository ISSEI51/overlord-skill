import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_ACCOUNT_ENV,
  AGENT_TOKEN_ENV,
  agentIdentity,
  describeAccount,
  ghEnvFor,
  githubHost,
  httpsHostOf,
  pushAttributionWarning,
  pushCredentialArgs,
  pushCredentialEnv,
  resetAgentIdentityCache,
  type AgentIdentity,
} from "./github-identity.ts";

/**
 * `GH_HOST` names the host the agent account belongs to, and the cases below
 * are written for the default one. A developer whose `gh` is logged in to a
 * GitHub Enterprise host exports it, and an inherited Enterprise value would
 * make `pushAttributionWarning` read a github.com remote as a foreign host —
 * a failure on a machine where nothing is wrong. The case that is about
 * `GH_HOST` sets it itself, through `withEnv`.
 */
delete process.env.GH_HOST;

/** Directories made for the tests, removed together at the end. */
const scratches: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "overlord-identity-"));
  scratches.push(directory);
  return directory;
}

afterAll(async () => {
  for (const directory of scratches) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A `gh` on PATH that answers `gh auth token --user <name>` from a table and
 * records every invocation, so both the token that comes back and the number of
 * times `gh` was run can be asserted.
 */
async function ghStub(
  tokens: Record<string, string>,
): Promise<{ dir: string; log: string; calls: () => Promise<string[]> }> {
  const dir = await scratch();
  const log = join(dir, "gh.log");
  const script = [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$GH_AUTH_STUB_LOG"',
    'if [ -f "$GH_AUTH_STUB_DIR/$4.token" ]; then',
    '  cat "$GH_AUTH_STUB_DIR/$4.token"',
    "  exit 0",
    "fi",
    'echo "no oauth token found for github.com account $4" >&2',
    "exit 1",
    "",
  ].join("\n");
  const executable = join(dir, "gh");
  await Bun.write(executable, script);
  chmodSync(executable, 0o755);
  for (const [account, token] of Object.entries(tokens)) {
    await Bun.write(join(dir, `${account}.token`), `${token}\n`);
  }
  return {
    dir,
    log,
    calls: async () =>
      (await Bun.file(log).exists())
        ? (await Bun.file(log).text()).split("\n").filter(Boolean)
        : [],
  };
}

/** The environment variables every test in this file owns. */
const OWNED = [
  AGENT_ACCOUNT_ENV,
  AGENT_TOKEN_ENV,
  "GH_HOST",
  "PATH",
  "GH_AUTH_STUB_DIR",
  "GH_AUTH_STUB_LOG",
];

/** Run `body` with `overrides` applied, then put the environment back. */
async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  body: () => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const name of OWNED) previous[name] = process.env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await body();
  } finally {
    for (const name of OWNED) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    resetAgentIdentityCache();
  }
}

/** Put `dir` first on PATH and point the stub at its own directory. */
function withStub(stub: {
  dir: string;
  log: string;
}): Record<string, string | undefined> {
  return {
    PATH: `${stub.dir}:${process.env.PATH ?? ""}`,
    GH_AUTH_STUB_DIR: stub.dir,
    GH_AUTH_STUB_LOG: stub.log,
  };
}

beforeEach(() => {
  resetAgentIdentityCache();
});

describe("resolving the agent account", () => {
  test("nothing configured leaves the commands on the active gh account", async () => {
    const resolution = await withEnv(
      { [AGENT_ACCOUNT_ENV]: undefined, [AGENT_TOKEN_ENV]: undefined },
      () => agentIdentity(),
    );
    expect(resolution.status).toBe("unconfigured");
  });

  test("a blank value is not a configured account", async () => {
    const resolution = await withEnv(
      { [AGENT_ACCOUNT_ENV]: "   ", [AGENT_TOKEN_ENV]: "" },
      () => agentIdentity(),
    );
    expect(resolution.status).toBe("unconfigured");
  });

  test("an account is resolved through gh auth token, without switching", async () => {
    const stub = await ghStub({ "ISSEI-BOT": "ghp_bot" });
    const resolution = await withEnv(
      { ...withStub(stub), [AGENT_ACCOUNT_ENV]: "ISSEI-BOT" },
      () => agentIdentity(),
    );
    expect(resolution).toEqual({
      status: "resolved",
      identity: {
        account: "ISSEI-BOT",
        token: "ghp_bot",
        source: "gh auth token --user ISSEI-BOT",
      },
    });
    expect(await stub.calls()).toEqual(["auth token --user ISSEI-BOT"]);
  });

  test("gh auth switch is never run", async () => {
    const stub = await ghStub({ "ISSEI-BOT": "ghp_bot" });
    await withEnv({ ...withStub(stub), [AGENT_ACCOUNT_ENV]: "ISSEI-BOT" }, () =>
      agentIdentity(),
    );
    expect((await stub.calls()).join("\n")).not.toContain("switch");
  });

  test("an account gh does not know fails instead of falling back", async () => {
    const stub = await ghStub({ "ISSEI-BOT": "ghp_bot" });
    const resolution = await withEnv(
      { ...withStub(stub), [AGENT_ACCOUNT_ENV]: "nobody" },
      () => agentIdentity(),
    );
    expect(resolution.status).toBe("failed");
    if (resolution.status !== "failed") throw new Error("unreachable");
    expect(resolution.reason).toContain("no oauth token found");
    expect(resolution.reason).toContain(AGENT_ACCOUNT_ENV);
  });

  test("a token in the environment is used directly", async () => {
    const stub = await ghStub({});
    const resolution = await withEnv(
      {
        ...withStub(stub),
        [AGENT_ACCOUNT_ENV]: undefined,
        [AGENT_TOKEN_ENV]: "ghp_direct",
      },
      () => agentIdentity(),
    );
    expect(resolution).toEqual({
      status: "resolved",
      identity: {
        account: null,
        token: "ghp_direct",
        source: `$${AGENT_TOKEN_ENV}`,
      },
    });
    expect(await stub.calls()).toEqual([]);
  });

  test("a resolved token is read once and then cached", async () => {
    const stub = await ghStub({ "ISSEI-BOT": "ghp_bot" });
    await withEnv({ ...withStub(stub), [AGENT_ACCOUNT_ENV]: "ISSEI-BOT" }, async () => {
      await agentIdentity();
      await agentIdentity();
      await agentIdentity();
    });
    expect(await stub.calls()).toHaveLength(1);
  });

  test("changing the configured account resolves again", async () => {
    const stub = await ghStub({ one: "ghp_one", two: "ghp_two" });
    const tokens = await withEnv(
      { ...withStub(stub), [AGENT_ACCOUNT_ENV]: "one" },
      async () => {
        const first = await agentIdentity();
        process.env[AGENT_ACCOUNT_ENV] = "two";
        const second = await agentIdentity();
        return [first, second];
      },
    );
    expect(tokens.map((r) => (r.status === "resolved" ? r.identity.token : r.status))).toEqual([
      "ghp_one",
      "ghp_two",
    ]);
  });
});

describe("the environment a gh call runs with", () => {
  test("a resolved account is handed to gh as GH_TOKEN", () => {
    expect(
      ghEnvFor({
        status: "resolved",
        identity: { account: "ISSEI-BOT", token: "ghp_bot", source: "test" },
      }),
    ).toEqual({ GH_TOKEN: "ghp_bot", GITHUB_TOKEN: "" });
  });

  test("no account configured changes nothing about the environment", () => {
    expect(ghEnvFor({ status: "unconfigured" })).toBeUndefined();
    expect(ghEnvFor({ status: "failed", reason: "x" })).toBeUndefined();
  });
});

/** The username the helper sends the token as; a label, not a secret. */
const CREDENTIAL_USERNAME = "x-access-token";

/**
 * `git -c` arguments installing a helper that answers with `password`.
 *
 * It stands in for whatever the machine has configured — the macOS keychain,
 * or the helper `gh auth setup-git` installs — so the cases below assert what
 * `pushCredentialArgs` does about an already configured helper rather than
 * what the developer happens to have in `~/.gitconfig`. A checkout whose
 * `origin` is ssh, and a machine with no github.com credential at all, get the
 * same competitor and therefore the same result.
 */
function otherHelper(username: string, password: string): string[] {
  return [
    "-c",
    `credential.helper=!printf 'username=${username}\\npassword=${password}\\n'`,
  ];
}

/** `git -c` arguments installing git's own helper, writing to `file`. */
function storeHelper(file: string): string[] {
  return ["-c", `credential.helper=store --file=${file}`];
}

/**
 * `git -c` arguments emptying the helper list the configuration files filled,
 * so that a case which installs its own helper is not answered first by
 * whatever the machine has configured for github.com.
 */
const NO_HELPER = ["-c", "credential.helper="];

/**
 * What a helper answered, with every value that could be a secret replaced by
 * a description of it.
 *
 * The assertions below compare this rather than the raw output, because a
 * failing `expect` prints what it received: on a machine where the reset
 * stopped working, that output is the developer's own GitHub credential, and
 * a test report is not a place to put one.
 */
function credentialShape(
  stdout: string,
  identity: AgentIdentity,
): { username: string; password: string } {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) fields.set(line.slice(0, equals), line.slice(equals + 1));
  }
  const username = fields.get("username");
  const password = fields.get("password");
  return {
    username:
      username === undefined
        ? "(no username)"
        : username === CREDENTIAL_USERNAME
          ? CREDENTIAL_USERNAME
          : "(another username)",
    password:
      password === undefined
        ? "(no password)"
        : password === identity.token
          ? "(the agent account's token)"
          : "(another secret)",
  };
}

/** Output with anything that looks like a credential taken out of it. */
function redacted(text: string): string {
  return text.replace(/^(username|password)=.*$/gm, "$1=(redacted)");
}

describe("the git credential of a push", () => {
  const identity = {
    account: "ISSEI-BOT",
    token: "ghp_push",
    source: "test",
  };

  test("the token is not on the command line", () => {
    expect(pushCredentialArgs().join(" ").includes(identity.token)).toBe(false);
  });

  test("a helper configured before this one answers on its own", async () => {
    // The control for the case below: the competing helper really does answer
    // for github.com when nothing resets it, so a run in which the agent
    // account's token comes back is a run in which the reset did the work.
    const filled = await credential(
      "fill",
      [...NO_HELPER, ...otherHelper("someone-else", "not-the-agent-token")],
      identity,
    );
    expect(filled.code).toBe(0);
    expect(credentialShape(filled.stdout, identity)).toEqual({
      username: "(another username)",
      password: "(another secret)",
    });
  });

  test("the helper answers github.com with the agent account's token", async () => {
    // Real git, real configuration: this is the assertion that the arguments
    // actually override an already configured helper — the macOS keychain and
    // the one `gh auth setup-git` installs, here stood in for by a helper this
    // test configures itself — rather than being appended behind it. Without
    // the reset in `pushCredentialArgs`, the helper installed first answers
    // and this test fails.
    const filled = await credential(
      "fill",
      [...otherHelper("someone-else", "not-the-agent-token"), ...pushCredentialArgs()],
      identity,
    );
    expect(filled.code).toBe(0);
    expect(credentialShape(filled.stdout, identity)).toEqual({
      username: CREDENTIAL_USERNAME,
      password: "(the agent account's token)",
    });
  });

  test("a store helper configured before this one does write, when it is not reset", async () => {
    // The control for the case below. It is what makes "nothing was stored"
    // mean something: without it, an assertion that no file appeared would
    // also pass if `git credential approve` never stored anything at all.
    const file = join(await scratch(), "credentials");
    const stored = await credential(
      "approve",
      [...NO_HELPER, ...storeHelper(file)],
      identity,
    );
    expect(stored.code).toBe(0);
    expect(await Bun.file(file).exists()).toBe(true);
  });

  test("the helper stores nothing, so the token stays out of the keychain", async () => {
    // `approve` is what git runs after a successful push. The helper must do
    // nothing and still exit 0: a non-zero helper makes git report an error
    // for a push that worked.
    //
    // A storing helper is configured first and, unlike the case above, is
    // reset by `pushCredentialArgs`, so the file it would have written is the
    // evidence: the agent's token reaches no store on the machine, which on a
    // developer's Mac is the login keychain every later push reads.
    const file = join(await scratch(), "credentials");
    const stored = await credential(
      "approve",
      [...storeHelper(file), ...pushCredentialArgs()],
      identity,
    );
    expect(stored.code).toBe(0);
    expect(redacted(stored.stdout)).toBe("");
    expect(redacted(stored.stderr)).toBe("");
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test("nothing git is told carries the token except the environment", async () => {
    const filled = await credential("fill", pushCredentialArgs(), identity);
    expect(filled.stderr.includes(identity.token)).toBe(false);
    expect(pushCredentialArgs().join(" ").includes(identity.token)).toBe(false);
    // The token is only in the value of the variable the helper reads.
    const env = pushCredentialEnv(identity);
    const carriers = Object.entries(env)
      .filter(([, value]) => value === identity.token)
      .map(([name]) => name);
    expect(carriers).toEqual(["OVERLORD_GIT_CREDENTIAL_TOKEN"]);
  });
});

/**
 * The helper itself, as git would run it.
 *
 * A `!`-prefixed helper value is run by git as `sh -c '<body> "$@"' <name>
 * <operation>`, with the request on stdin. Running it that way, rather than
 * through `git credential`, is the only way to ask it about a host git would
 * never ask it about here — which is the case the host check exists for.
 *
 * The body is read back out of `pushCredentialArgs`, so what is exercised is
 * the value git is actually handed and not a second copy of it.
 */
async function runHelper(
  operation: string,
  request: string,
  identity: AgentIdentity,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = pushCredentialArgs();
  const value = args[args.length - 1]!;
  const body = value.slice(value.indexOf("=") + 1).replace(/^!/, "");
  const proc = Bun.spawn(["sh", "-c", `${body} "$@"`, "credential-helper", operation], {
    env: { ...process.env, ...pushCredentialEnv(identity), ...env },
    stdin: new TextEncoder().encode(request),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** One credential request, as git writes it on the helper's stdin. */
function request(fields: Record<string, string>): string {
  return `${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("")}\n`;
}

describe("the host the credential helper answers for", () => {
  const identity = { account: "ISSEI-BOT", token: "ghp_host", source: "test" };

  test("the host it was given over https is answered", async () => {
    const answered = await runHelper(
      "get",
      request({ protocol: "https", host: "github.com" }),
      identity,
    );
    expect(answered.code).toBe(0);
    expect(credentialShape(answered.stdout, identity)).toEqual({
      username: CREDENTIAL_USERNAME,
      password: "(the agent account's token)",
    });
  });

  test("another host gets nothing, so the token does not leave its own host", async () => {
    // The case `pushIdentity` cannot see: one `git push` that asks for a
    // credential for somewhere else — an authenticated `http.proxy`, or a
    // redirect — after the remote itself was checked and accepted.
    for (const host of [
      "gitlab.com",
      "proxy.internal",
      "github.com.evil.example",
      "evil-github.com",
      "GITHUB.COM.attacker.test",
      "",
    ]) {
      const answered = await runHelper(
        "get",
        request({ protocol: "https", host }),
        identity,
      );
      // `redacted` rather than the raw output: a case that starts failing must
      // not print the credential it was not supposed to hand over.
      expect(redacted(answered.stdout)).toBe("");
      // Silence, not failure: a helper that exits non-zero makes git report an
      // error for a request another helper may legitimately answer.
      expect(answered.code).toBe(0);
    }
  });

  test("the same host without https gets nothing", async () => {
    // A token sent in the clear is a leaked token, whoever is listening.
    for (const protocol of ["http", "ftp", ""]) {
      const answered = await runHelper(
        "get",
        request({ protocol, host: "github.com" }),
        identity,
      );
      expect(redacted(answered.stdout)).toBe("");
      expect(answered.code).toBe(0);
    }
  });

  test("a request that names no host at all gets nothing", async () => {
    const answered = await runHelper("get", "\n", identity);
    expect(redacted(answered.stdout)).toBe("");
    expect(answered.code).toBe(0);
  });

  test("an Enterprise host is answered, with a port and without", async () => {
    // `GH_HOST` moves the host the account belongs to, and a port does not
    // change whose host it is.
    await withEnv({ GH_HOST: "github.example.com" }, async () => {
      for (const host of ["github.example.com", "github.example.com:8443"]) {
        const answered = await runHelper(
          "get",
          request({ protocol: "https", host }),
          identity,
        );
        expect(credentialShape(answered.stdout, identity)).toEqual({
          username: CREDENTIAL_USERNAME,
          password: "(the agent account's token)",
        });
      }
      // github.com is the foreign host now, and gets nothing.
      const other = await runHelper(
        "get",
        request({ protocol: "https", host: "github.com" }),
        identity,
      );
      expect(redacted(other.stdout)).toBe("");
      expect(other.code).toBe(0);
    });
  });

  test("store and erase print nothing and succeed, for its own host too", async () => {
    for (const operation of ["store", "erase"]) {
      const answered = await runHelper(
        operation,
        request({
          protocol: "https",
          host: "github.com",
          username: "x-access-token",
          password: identity.token,
        }),
        identity,
      );
      expect(redacted(answered.stdout)).toBe("");
      expect(redacted(answered.stderr)).toBe("");
      expect(answered.code).toBe(0);
    }
  });
});

/**
 * Run git's credential machinery for github.com with `args` applied.
 *
 * `git credential fill` and `git credential approve` are that machinery on its
 * own, with no network and no repository, so the helper a push installs is
 * exercised exactly as git would run it.
 */
async function credential(
  operation: "fill" | "approve",
  args: string[],
  identity: AgentIdentity,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const input =
    operation === "fill"
      ? "protocol=https\nhost=github.com\n\n"
      : `protocol=https\nhost=github.com\nusername=x-access-token\n` +
        `password=${identity.token}\n\n`;
  const proc = Bun.spawn(["git", ...args, "credential", operation], {
    env: { ...process.env, ...pushCredentialEnv(identity) },
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("which remotes the agent account can be used on", () => {
  const identity = { account: "ISSEI-BOT", token: "ghp_bot", source: "test" };

  test("github.com over https carries the credential", () => {
    expect(
      pushAttributionWarning(
        identity,
        "https://github.com/ISSEI51/overlord-skill.git",
      ),
    ).toBeNull();
  });

  test("an ssh remote is reported, because no token can be injected into it", () => {
    const warning = pushAttributionWarning(
      identity,
      "git@github.com:ISSEI51/overlord-skill.git",
    );
    expect(warning).toContain("not an HTTPS URL");
    expect(warning).toContain("ISSEI-BOT");
  });

  test("another host is reported, and its token is not sent there", () => {
    const warning = pushAttributionWarning(
      identity,
      "https://gitlab.com/someone/project.git",
    );
    expect(warning).toContain("gitlab.com");
  });

  test("GH_HOST moves the host the account belongs to", async () => {
    await withEnv({ GH_HOST: "github.example.com" }, async () => {
      expect(githubHost()).toBe("github.example.com");
      expect(
        pushAttributionWarning(
          identity,
          "https://github.example.com/team/project.git",
        ),
      ).toBeNull();
      expect(
        pushAttributionWarning(identity, "https://github.com/team/project.git"),
      ).toContain("github.com");
    });
  });

  test("a host is matched without regard to case", () => {
    expect(httpsHostOf("HTTPS://GitHub.com/a/b.git")).toBe("github.com");
    expect(httpsHostOf("https://user@github.com/a/b.git")).toBe("github.com");
    expect(httpsHostOf("/srv/git/bare.git")).toBeNull();
    expect(httpsHostOf("http://github.com/a/b.git")).toBeNull();
  });
});

describe("naming the account in the output", () => {
  test("a gh account is named by its account name", () => {
    expect(
      describeAccount({ account: "ISSEI-BOT", token: "t", source: "s" }),
    ).toBe("ISSEI-BOT");
  });

  test("a bare token has no name to report", () => {
    expect(describeAccount({ account: null, token: "t", source: "s" })).toBe(
      `the token in $${AGENT_TOKEN_ENV}`,
    );
  });
});
