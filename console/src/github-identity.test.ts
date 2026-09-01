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

describe("the git credential of a push", () => {
  const identity = {
    account: "ISSEI-BOT",
    token: "ghp_push",
    source: "test",
  };

  test("the token is not on the command line", () => {
    expect(pushCredentialArgs().join(" ")).not.toContain(identity.token);
  });

  test("the helper answers github.com with the agent account's token", async () => {
    // Real git, real configuration: this is the assertion that the arguments
    // actually override the macOS keychain and the `gh auth setup-git` helper
    // that the user's own pushes use, rather than being appended behind them.
    // Without the reset in `pushCredentialArgs`, the developer's own account
    // answers first and this test fails.
    const filled = await credential("fill", pushCredentialArgs(), identity);
    expect(filled.stdout).toContain("username=x-access-token");
    expect(filled.stdout).toContain(`password=${identity.token}`);
    expect(filled.code).toBe(0);
  });

  test("the helper stores nothing, so the token stays out of the keychain", async () => {
    // `approve` is what git runs after a successful push. The helper must do
    // nothing and still exit 0: a non-zero helper makes git report an error
    // for a push that worked.
    const stored = await credential("approve", pushCredentialArgs(), identity);
    expect(stored.stdout).toBe("");
    expect(stored.stderr).toBe("");
    expect(stored.code).toBe(0);
  });

  test("nothing git is told carries the token except the environment", async () => {
    const filled = await credential("fill", pushCredentialArgs(), identity);
    expect(filled.stderr).not.toContain(identity.token);
    expect(pushCredentialArgs().join(" ")).not.toContain(identity.token);
    // The token is only in the value of the variable the helper reads.
    const env = pushCredentialEnv(identity);
    const carriers = Object.entries(env)
      .filter(([, value]) => value === identity.token)
      .map(([name]) => name);
    expect(carriers).toEqual(["OVERLORD_GIT_CREDENTIAL_TOKEN"]);
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
