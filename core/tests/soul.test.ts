// KAI's identity must exist and hold up with every worker offline.
//
//   cd core && node --test tests/soul.test.ts
//
// The load-bearing test here is "loads with Hermes unreachable": if KAI's sense of self
// ever grows a dependency on a worker, that test is what fails. Everything else checks
// that the loader degrades honestly rather than producing an empty or leaking identity.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveKaiHome, defaultKaiHome } from "../src/agent/kai-home.ts";
import { createKaiIdentity, redactSecrets, MAX_DOC_CHARS, BUILT_IN_SOUL } from "../src/agent/soul.ts";

function tempHome(name: string): string {
  return mkdtempSync(join(tmpdir(), `kai-home-${name}-`));
}

test("a first run seeds KAI's own identity tree and says so", () => {
  const root = tempHome("seed");
  try {
    // The identity provider is what seeds on first run, so build it first: a resolve
    // that follows would correctly report nothing new.
    const id = createKaiIdentity({ root }).identity();
    assert.equal(id.seeded.length, 11, "the KAI-owned identity tree is created once");
    assert.deepEqual(id.seeded, [
      join(root, "identity", "SOUL.md"),
      join(root, "user", "USER.md"),
      join(root, "memory", "MEMORY.md"),
      join(root, "identity", "IDENTITY.md"),
      join(root, "identity", "CAPABILITIES.md"),
      join(root, "skills", "SKILLS.md"),
      join(root, "workforce", "WORKFORCE.md"),
      join(root, "workforce", "DELEGATION.md"),
      join(root, "policy", "SAFETY.md"),
      join(root, "upgrades", "LEARNING.md"),
      join(root, "upgrades", "UPGRADES.md"),
    ]);

    const home = resolveKaiHome(root);
    assert.ok(existsSync(home.soul) && existsSync(home.user) && existsSync(home.memory));
    assert.ok(existsSync(home.identity) && existsSync(home.capabilities));
    assert.ok(existsSync(home.skills), "the skills directory is created too");
    assert.equal(home.seeded.length, 0, "a second resolve creates nothing");
    assert.ok(id.soul.length > 200, "the seeded soul is a real document, not a placeholder");
    assert.ok(id.soul.includes("I am KAI"), "it says who KAI is");
    assert.match(id.soul, /worker/i, "and it names the workers as workers");
    // The identity invariant and capabilities are KAI's own documents, loaded too.
    assert.match(id.identity, /main agent and the conversation owner/);
    assert.match(id.identity, /worker provides information/i);
    assert.match(id.capabilities, /cannot do/i);
    assert.equal(id.problems.length, 0);
    assert.equal(id.version.length, 8, "an identity version the UI can display");
    assert.equal(id.source.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the identity tree is KAI's own: no worker self-claim, no Nous Research, no HERMES_ path", () => {
  const root = tempHome("no-leak");
  try {
    const id = createKaiIdentity({ root }).identity();
    const whole = [id.soul, id.identity, id.capabilities, id.user, id.memory, id.workforce, id.policy].join("\n");
    // Workers may be NAMED where they correctly name a worker...
    assert.match(whole, /Hermes/);
    assert.match(whole, /worker/i);
    // ...but none of the Hermes identity leakage may appear in KAI's identity layer.
    assert.doesNotMatch(whole, /Nous Research/i);
    assert.doesNotMatch(whole, /Hermes Agent/i);
    assert.doesNotMatch(whole, /HERMES_/);
    assert.doesNotMatch(whole, /I am (?:Hermes|an? assistant|a language model)/i);
    assert.doesNotMatch(whole, /under the hood/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an older flat KAI_HOME is migrated, preserving the user's edited soul", () => {
  const root = tempHome("migrate");
  try {
    // A pre-tree install: SOUL.md and USER.md at the root, hand-edited.
    writeFileSync(join(root, "SOUL.md"), "# SOUL\n\nI am KAI, and this is my edited soul.\n", "utf8");
    writeFileSync(join(root, "USER.md"), "# USER\n\n- the user's own note\n", "utf8");
    const id = createKaiIdentity({ root }).identity();
    assert.match(id.soul, /this is my edited soul/, "the user's soul survived the structure change");
    assert.match(id.user, /the user's own note/);
    assert.equal(id.seeded.length, 11, "the tree is created; the two migrated docs are created here too");
    assert.ok(existsSync(join(root, "identity", "SOUL.md")));
    assert.ok(existsSync(join(root, "user", "USER.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the soul is KAI's, not a worker's: it must not claim Hermes is the self", () => {
  const root = tempHome("distinct");
  try {
    const id = createKaiIdentity({ root }).identity();
    // It must *mention* the workers (to say what they are) while being KAI's own text.
    assert.match(id.soul, /Hermes/);
    assert.doesNotMatch(id.soul, /I am Hermes/i);
    assert.doesNotMatch(id.soul, /my name is Hermes/i);
    assert.match(id.soul, /not a front end for anything else|I am KAI/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity loads with Hermes unreachable — KAI does not depend on a worker to exist", async () => {
  const root = tempHome("offline");
  const previous = process.env.KAI_HERMES_URL;
  try {
    // Point every agent endpoint at a closed port: if loading needed one, this fails.
    process.env.KAI_HERMES_URL = "http://127.0.0.1:9";
    process.env.KAI_OPENCODE_URL = "http://127.0.0.1:9";

    const provider = createKaiIdentity({ root });
    const id = provider.identity();
    assert.ok(id.soul.length > 0, "KAI still knows who it is");
    assert.ok(provider.systemPrompt().includes("I am KAI"));
    assert.ok(provider.selfDescription().length > 0, "KAI can still say what it is");

    // And it does not reach out: a fetch would have to be attempted for this to matter,
    // so assert the module has no network import at all in the loader's own file.
    const loader = readFileSync(join("src", "agent", "soul.ts"), "utf8");
    assert.doesNotMatch(loader, /fetch\(|node:http|node:net/, "the identity loader performs no I/O beyond its files");
  } finally {
    if (previous === undefined) delete process.env.KAI_HERMES_URL;
    else process.env.KAI_HERMES_URL = previous;
    delete process.env.KAI_OPENCODE_URL;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing or empty soul degrades to the built-in identity and records why", () => {
  const root = tempHome("missing");
  try {
    const home = resolveKaiHome(root);
    // Unreadable-looking case: replaced by an empty file.
    writeFileSync(home.soul, "   \n\n", "utf8");
    const id = createKaiIdentity({ root }).identity();
    assert.equal(id.soul, BUILT_IN_SOUL, "an empty soul is not an empty identity");
    assert.ok(
      id.problems.some((p) => /SOUL\.md is empty/.test(p)),
      `the gap is reported: ${JSON.stringify(id.problems)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an over-long document is bounded, and the truncation is admitted", () => {
  const root = tempHome("bound");
  try {
    const home = resolveKaiHome(root);
    // Prose, not one long run: a 40+ character unbroken alphanumeric string is
    // deliberately treated as a credential blob and redacted (see the test below), so
    // padding made of a single repeated character would never reach the size bound.
    const prose = "This is an ordinary line of the soul document.\n".repeat(400);
    writeFileSync(home.soul, `I am KAI.\n${prose}`, "utf8");
    const id = createKaiIdentity({ root }).identity();
    assert.ok(id.soul.length < MAX_DOC_CHARS + 200, "a runaway file cannot swamp a prompt");
    assert.ok(id.soul.includes("[truncated"));
    assert.ok(id.problems.some((p) => /truncated/.test(p)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a credential in USER.md never reaches a prompt", () => {
  const root = tempHome("secrets");
  try {
    const home = resolveKaiHome(root);
    const KEY = "sk-live-DO-NOT-LEAK-0123456789abcdefGHIJ";
    writeFileSync(home.user, `# USER\n\n- prefers short answers\n- api_key: ${KEY}\n`, "utf8");

    const provider = createKaiIdentity({ root });
    const prompt = provider.systemPrompt();
    assert.ok(prompt.includes("prefers short answers"), "the real preference is kept");
    assert.ok(!prompt.includes(KEY), "the credential is gone");
    assert.ok(!prompt.includes("DO-NOT-LEAK"), "not even a fragment of it");
    assert.match(prompt, /\[redacted\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redaction covers the shapes a secret actually takes", () => {
  assert.ok(!redactSecrets("token=abc123def456ghi").includes("abc123def456ghi"));
  assert.ok(!redactSecrets("Authorization: Bearer aVeryLongOpaqueToken12345").includes("aVeryLongOpaqueToken12345"));
  assert.ok(!redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz01").includes("ghp_abcdefghij"));
  assert.ok(!redactSecrets("deadbeef".repeat(8)).includes("deadbeef"));
  // Ordinary prose survives untouched.
  const prose = "Prefers concise answers and works in French sometimes.";
  assert.equal(redactSecrets(prose), prose);

  // Documented side effect: any unbroken run of 40+ alphanumerics is treated as a blob,
  // even if it is harmless, because that is the shape a leaked key takes. Conservative
  // by design — a mangled unusual line is better than a key in a prompt. Prose is
  // unaffected because words are separated by spaces.
  assert.equal(redactSecrets("x".repeat(45)), "[redacted]");
  assert.equal(redactSecrets("a normal sentence with short words"), "a normal sentence with short words");
});

test("reload picks up an edit, and the identity version changes with it", () => {
  const root = tempHome("reload");
  try {
    const home = resolveKaiHome(root);
    const provider = createKaiIdentity({ root });
    const first = provider.identity().version;

    writeFileSync(home.soul, "# SOUL\n\nI am KAI, and I have been edited.\n", "utf8");
    const reloaded = provider.reload();
    assert.notEqual(reloaded.version, first, "a changed soul is a new identity version");
    assert.match(reloaded.soul, /I have been edited/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the composed prompt omits empty sections instead of leaving bare headings", () => {
  const root = tempHome("compose");
  try {
    const home = resolveKaiHome(root);
    writeFileSync(home.user, "", "utf8");
    writeFileSync(home.memory, "", "utf8");
    const prompt = createKaiIdentity({ root }).systemPrompt();
    assert.ok(prompt.includes("# Who I am"));
    assert.ok(!prompt.includes("# What I know about the user"), "no heading with nothing under it");
    assert.ok(!prompt.includes("# What I remember"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default home is outside the repository", () => {
  const previous = process.env.KAI_HOME;
  try {
    delete process.env.KAI_HOME;
    const home = defaultKaiHome();
    assert.ok(!home.includes("Desktop"), `KAI's identity must not live in a checkout: ${home}`);
    assert.ok(home.toLowerCase().includes("kai"), home);
  } finally {
    if (previous !== undefined) process.env.KAI_HOME = previous;
  }
});

test("the self-description is a real sentence, never SOUL.md's markdown heading", () => {
  const root = tempHome("selfdesc");
  try {
    // The seeded soul starts with the ATX heading `# SOUL — who KAI is`. That heading
    // used to BE the self-description, so KAI literally said a markdown heading as
    // what it is and the next sentence was concatenated onto it without a break.
    const provider = createKaiIdentity({ root });
    const self = provider.selfDescription();

    assert.ok(!self.startsWith("#"), `no leading heading marker: ${JSON.stringify(self)}`);
    assert.ok(!self.includes("#"), `no heading anywhere: ${JSON.stringify(self)}`);
    assert.ok(!/SOUL\s*—/.test(self), "SOUL.md's heading text must not leak into it");
    assert.ok(!self.includes("\n"), "a self-description is one sentence, not a block");
    assert.match(self, /^I am KAI[.,]/, `it says who KAI is: ${JSON.stringify(self)}`);
    assert.match(self, /[.!?]$/, `a well-formed sentence ends with punctuation: ${JSON.stringify(self)}`);
    // Exactly one sentence: one terminal punctuation run at the end.
    assert.equal((self.match(/[.!?](?=\s|$)/g) ?? []).length, 1, `one sentence: ${JSON.stringify(self)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a heading-only soul falls back to the built-in sentence, not the heading", () => {
  const root = tempHome("headingonly");
  try {
    const home = resolveKaiHome(root);
    writeFileSync(home.soul, "# SOUL — who KAI is\n\n## How I work\n\n", "utf8");
    const self = createKaiIdentity({ root }).selfDescription();
    assert.ok(!self.startsWith("#"));
    assert.ok(!self.includes("SOUL"));
    assert.equal(self, "I am KAI, the user's own agent on this machine.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a soul whose first sentence is real returns that sentence, not its heading", () => {
  const root = tempHome("firstsentence");
  try {
    const home = resolveKaiHome(root);
    writeFileSync(home.soul, "# SOUL\n\nI am KAI, the machine's own agent. More prose follows.\n", "utf8");
    const self = createKaiIdentity({ root }).selfDescription();
    assert.equal(self, "I am KAI, the machine's own agent.");
    assert.ok(!self.includes("#"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
