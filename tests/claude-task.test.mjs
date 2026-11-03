#!/usr/bin/env node
// Native Node tests for bin/claude-task.mjs. No third-party packages, no network
// access beyond a localhost webhook receiver, and never invokes real Claude.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const CLI = join(REPO, "bin", "claude-task.mjs");

const FAKE_CLAUDE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const get = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = get("-p") || "";
const logDir = process.env.FAKE_CLAUDE_DIR;
if (logDir) {
  try {
    fs.appendFileSync(
      path.join(logDir, "calls.jsonl"),
      JSON.stringify({ argv, cwd: process.cwd(), env: Object.keys(process.env) }) + "\\n",
    );
  } catch {}
}

const resume = get("--resume");
const session = resume || "sess-test-123";
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "system", subtype: "init", session_id: session, model: get("--model"), tools: [] });

if (prompt.includes("SLOW")) {
  setInterval(() => {}, 1000);
} else if (prompt.includes("FAIL")) {
  emit({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "partial: " + prompt }] },
  });
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "FAILED: " + prompt,
    duration_ms: 7,
    total_cost_usd: 0.01,
    session_id: session,
  });
} else {
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "assistant says " + prompt },
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/example.txt" } },
      ],
    },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "RESULT: " + prompt,
    duration_ms: 42,
    total_cost_usd: 0.002,
    session_id: session,
  });
}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(intervalMs);
  }
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "claude-task-test-"));
  const taskDir = join(root, "tasks");
  const fakeDir = join(root, "fake");
  const cwd = join(root, "project");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const fake = join(fakeDir, "claude.mjs");
  writeFileSync(fake, FAKE_CLAUDE);
  chmodSync(fake, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, taskDir, fakeDir, fake, cwd };
}

function baseEnv(sandbox, extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "PI_NOTIFY_URL",
    "PI_NOTIFY_SECRET",
    "PI_NOTIFY_OFF",
    "TELEGRAM_BOT_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "CLAUDE_TASK_OWNER",
    "CLAUDE_TASK_DIR",
    "CLAUDE_BIN",
    "FAKE_CLAUDE_DIR",
  ]) {
    delete env[key];
  }
  return Object.assign(env, {
    CLAUDE_TASK_DIR: sandbox.taskDir,
    CLAUDE_BIN: sandbox.fake,
    FAKE_CLAUDE_DIR: sandbox.fakeDir,
  }, extra);
}

function runCli(args, env, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function taskIdFrom(stdout) {
  const m = stdout.match(/^TASK (.+)$/m);
  assert.ok(m, `missing TASK line in: ${stdout}`);
  return m[1].trim();
}

const statusOf = (sandbox, id) =>
  JSON.parse(readFileSync(join(sandbox.taskDir, id, "status.json"), "utf8"));

function eventsOf(sandbox, id) {
  const file = join(sandbox.taskDir, id, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function callsOf(sandbox) {
  const file = join(sandbox.fakeDir, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function hasPair(argv, a, b) {
  const i = argv.indexOf(a);
  return i >= 0 && argv[i + 1] === b;
}

test("run completes with done state, stream-json log and result.md", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const r = await runCli([
    "run", sandbox.cwd, "hello world", "--session", "demo", "--model", "sonnet", "--owner", "bot-a",
  ], env);

  assert.equal(r.code, 0, r.stderr);
  const id = taskIdFrom(r.stdout);
  assert.match(r.stdout, /STATE done/);
  assert.match(r.stdout, /RESULT /);

  const st = statusOf(sandbox, id);
  assert.equal(st.state, "done");
  assert.equal(st.exit_code, 0);
  assert.equal(st.owner, "bot-a");
  assert.equal(st.model, "sonnet");
  assert.equal(st.claude_session_id, "sess-test-123");
  assert.equal(st.cwd, sandbox.cwd);
  assert.equal(st.reported, false);
  assert.equal(st.runs.length, 1);
  assert.equal(st.runs[0].model, "sonnet");

  assert.equal(
    readFileSync(join(sandbox.taskDir, id, "result.md"), "utf8"),
    "RESULT: hello world\n",
  );

  const raw = readFileSync(join(sandbox.taskDir, id, "claude.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(raw[0].type, "system");
  assert.equal(raw[0].subtype, "init");
  assert.equal(raw[1].type, "assistant");
  assert.equal(raw[2].type, "result");

  const types = eventsOf(sandbox, id).map((e) => e.type);
  assert.ok(types.includes("task_start"));
  assert.ok(types.includes("session_init"));
  assert.ok(types.includes("message_end"));
  assert.ok(types.includes("result"));
  assert.ok(types.includes("task_end"));

  const calls = callsOf(sandbox);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, sandbox.cwd);
  const argv = calls[0].argv;
  assert.ok(hasPair(argv, "--model", "sonnet"));
  assert.ok(hasPair(argv, "--permission-mode", "acceptEdits"));
  assert.ok(!argv.includes("--disallowedTools"));
  assert.ok(!argv.includes("--resume"));
  assert.ok(hasPair(argv, "--output-format", "stream-json"));
  assert.ok(argv.includes("--verbose"));
  assert.ok(hasPair(argv, "-p", "hello world"));
});

test("status and list print task state and owner", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const run = await runCli([
    "run", sandbox.cwd, "listed task", "--session", "listed", "--model", "haiku", "--owner", "bot-b",
  ], env);
  assert.equal(run.code, 0, run.stderr);
  const id = taskIdFrom(run.stdout);

  const status = await runCli(["status", id], env);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`id:\\s+${id}`));
  assert.match(status.stdout, /state:\s+done/);
  assert.match(status.stdout, /owner:\s+bot-b/);
  assert.match(status.stdout, /model:\s+haiku/);
  assert.match(status.stdout, /claude:\s+sess-test-123/);
  assert.match(status.stdout, /options:\s+write=true web=true/);

  const list = await runCli(["list"], env);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(list.stdout.includes(id));
  assert.match(list.stdout, /owner=bot-b\s+done\s+runs=1/);

  const filtered = await runCli(["list", "--owner", "bot-c"], env);
  assert.equal(filtered.code, 0, filtered.stderr);
  assert.ok(!filtered.stdout.includes(id));
});

test("pending, ack and reply use the original model/session and re-open reporting", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const run = await runCli([
    "run", sandbox.cwd, "first turn", "--session", "follow", "--model", "opus", "--owner", "bot-p",
  ], env);
  assert.equal(run.code, 0, run.stderr);
  const id = taskIdFrom(run.stdout);

  let pending = await runCli(["pending", "--owner", "bot-p"], env);
  assert.equal(pending.code, 0, pending.stderr);
  assert.ok(pending.stdout.includes(id));

  const ack = await runCli(["ack", id, "--owner", "bot-p"], env);
  assert.equal(ack.code, 0, ack.stderr);
  assert.match(ack.stdout, new RegExp(`ACK ${id}`));
  pending = await runCli(["pending", "--owner", "bot-p"], env);
  assert.ok(!pending.stdout.includes(id));

  const reply = await runCli(["reply", id, "follow up"], env);
  assert.equal(reply.code, 0, reply.stderr);
  assert.match(reply.stdout, /STATE done/);

  const st = statusOf(sandbox, id);
  assert.equal(st.state, "done");
  assert.equal(st.model, "opus");
  assert.equal(st.reported, false);
  assert.equal(st.runs.length, 2);
  assert.equal(st.runs[1].model, "opus");
  assert.equal(st.runs[1].claude_session_id, "sess-test-123");
  assert.equal(
    readFileSync(join(sandbox.taskDir, id, "result.md"), "utf8"),
    "RESULT: follow up\n",
  );

  pending = await runCli(["pending", "--owner", "bot-p"], env);
  assert.ok(pending.stdout.includes(id));

  const calls = callsOf(sandbox);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cwd, sandbox.cwd);
  assert.ok(hasPair(calls[1].argv, "--resume", "sess-test-123"));
  assert.ok(hasPair(calls[1].argv, "-p", "follow up"));
});

test("cancel kills the Claude process group and records cancelled", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const child = spawn(
    process.execPath,
    [CLI, "run", sandbox.cwd, "SLOW job", "--session", "slow", "--model", "haiku", "--owner", "bot-c"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
  child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
  const closed = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  const id = await waitFor(() => {
    let ids = [];
    try {
      ids = readdirSync(sandbox.taskDir);
    } catch {
      return null;
    }
    for (const candidate of ids) {
      try {
        const st = JSON.parse(
          readFileSync(join(sandbox.taskDir, candidate, "status.json"), "utf8"),
        );
        if (st.state === "running" && st.claude_pid) return candidate;
      } catch {}
    }
    return null;
  }, 15000);

  const cancel = await runCli(["cancel", id], env);
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.match(cancel.stdout, new RegExp(`CANCELLED ${id}`));

  const st = statusOf(sandbox, id);
  assert.equal(st.state, "cancelled");
  assert.equal(st.exit_code, 130);
  assert.equal(st.pid, null);
  assert.equal(st.claude_pid, null);

  const end = await closed;
  assert.equal(end.code, 130, stderr);
  assert.match(stdout, /STATE cancelled/);
  assert.ok(eventsOf(sandbox, id).some((e) => e.type === "cancel_signal"));
});

test("orphan detection marks a running task interrupted", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const id = "orphan-20260101-000000";
  const dir = join(sandbox.taskDir, id);
  mkdirSync(dir, { recursive: true });
  const created = new Date(Date.now() - 120000).toISOString();
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    id,
    session: "orphan",
    owner: null,
    cwd: sandbox.cwd,
    model: "haiku",
    state: "running",
    pid: 999999,
    claude_pid: null,
    claude_session_id: null,
    created_at: created,
    started_at: created,
    ended_at: null,
    exit_code: null,
    error: null,
    reported: false,
    runs: [],
    options: { write: true, web: true },
  }, null, 2));

  const status = await runCli(["status", id], env);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /state:\s+interrupted/);

  const st = statusOf(sandbox, id);
  assert.equal(st.state, "interrupted");
  assert.equal(st.pid, null);
  assert.match(st.error, /orphaned/);
  assert.ok(eventsOf(sandbox, id).some((e) => e.type === "orphan_detected"));
});

test("webhook receives claude-task metadata with Bearer auth", async (t) => {
  const sandbox = makeSandbox(t);
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d.toString("utf8"); });
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{\"ok\":true}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/hook`;

  const env = baseEnv(sandbox, {
    PI_NOTIFY_URL: url,
    PI_NOTIFY_SECRET: "epoch-secret",
  });
  const run = await runCli([
    "run", sandbox.cwd, "notify me", "--session", "notify", "--model", "sonnet", "--owner", "bot-w",
  ], env);
  assert.equal(run.code, 0, run.stderr);
  const id = taskIdFrom(run.stdout);

  await waitFor(() => received.length > 0, 15000);
  const got = received[0];
  assert.equal(got.body.source, "claude-task");
  assert.equal(got.body.id, id);
  assert.equal(got.body.owner, "bot-w");
  assert.equal(got.body.state, "done");
  assert.equal(got.body.exit_code, 0);
  assert.equal(got.headers.authorization, "Bearer epoch-secret");

  await waitFor(
    () => eventsOf(sandbox, id).some((e) => e.type === "notify"),
    10000,
  );
});

test("Claude child environment omits notification and messaging secrets", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox, {
    PI_NOTIFY_URL: "http://127.0.0.1:9/never",
    PI_NOTIFY_SECRET: "should-not-leak",
    TELEGRAM_BOT_TOKEN: "123456:should-not-leak",
    CLOUDFLARE_API_TOKEN: "cf-should-not-leak",
    ANTHROPIC_API_KEY: "anthropic-key-for-test",
  });
  const run = await runCli([
    "run", sandbox.cwd, "env check", "--session", "env", "--model", "haiku", "--owner", "bot-e",
  ], env);
  assert.equal(run.code, 0, run.stderr);

  const calls = callsOf(sandbox);
  assert.equal(calls.length, 1);
  const names = new Set(calls[0].env);
  assert.ok(names.has("ANTHROPIC_API_KEY"));
  assert.ok(!names.has("PI_NOTIFY_URL"));
  assert.ok(!names.has("PI_NOTIFY_SECRET"));
  assert.ok(!names.has("TELEGRAM_BOT_TOKEN"));
  assert.ok(!names.has("CLOUDFLARE_API_TOKEN"));
});

test("run rejects a missing cwd or a cwd that is not a directory", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const missing = join(sandbox.root, "does-not-exist");

  const absent = await runCli([
    "run", missing, "cwd check", "--session", "bad-cwd", "--model", "haiku",
  ], env);
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /cwd is not a directory/);

  const notDir = join(sandbox.root, "not-a-directory");
  writeFileSync(notDir, "file\n");
  const file = await runCli([
    "run", notDir, "cwd check", "--session", "bad-cwd", "--model", "haiku",
  ], env);
  assert.equal(file.code, 2);
  assert.match(file.stderr, /cwd is not a directory/);
  assert.deepEqual(readdirSync(sandbox.taskDir), []);
});

test("run rejects missing and invalid models", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);

  const missing = await runCli(["run", sandbox.cwd, "no model", "--session", "bad-model"], env);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--model/);

  const invalid = await runCli([
    "run", sandbox.cwd, "bad model", "--session", "bad-model", "--model", "gpt",
  ], env);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /invalid --model: gpt/);

  const fullName = await runCli([
    "run", sandbox.cwd, "full model name", "--session", "full-model",
    "--model", "claude-sonnet-4-5", "--owner", "bot-m",
  ], env);
  assert.equal(fullName.code, 0, fullName.stderr);
  const calls = callsOf(sandbox);
  assert.ok(hasPair(calls[calls.length - 1].argv, "--model", "claude-sonnet-4-5"));
});

test("--no-write and --no-web map to Claude permission flags", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const run = await runCli([
    "run", sandbox.cwd, "restricted", "--session", "restricted", "--model", "haiku",
    "--owner", "bot-r", "--no-write", "--no-web",
  ], env);
  assert.equal(run.code, 0, run.stderr);
  const id = taskIdFrom(run.stdout);

  const calls = callsOf(sandbox);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, sandbox.cwd);
  const argv = calls[0].argv;
  assert.ok(hasPair(argv, "--permission-mode", "plan"));
  const i = argv.indexOf("--disallowedTools");
  assert.ok(i >= 0);
  assert.deepEqual(argv.slice(i + 1, i + 3), ["WebFetch", "WebSearch"]);

  const st = statusOf(sandbox, id);
  assert.equal(st.options.write, false);
  assert.equal(st.options.web, false);
});

test("CLAUDE_TASK_OWNER supplies the default owner", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox, { CLAUDE_TASK_OWNER: "bot-env" });
  const run = await runCli([
    "run", sandbox.cwd, "owner fallback", "--session", "owner-env", "--model", "haiku",
  ], env);
  assert.equal(run.code, 0, run.stderr);
  const id = taskIdFrom(run.stdout);
  assert.equal(statusOf(sandbox, id).owner, "bot-env");

  const pending = await runCli(["pending", "--owner", "bot-env"], env);
  assert.equal(pending.code, 0, pending.stderr);
  assert.ok(pending.stdout.includes(id));
});

test("reply can override the model while retaining the session", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const run = await runCli([
    "run", sandbox.cwd, "start with opus", "--session", "override", "--model", "opus", "--owner", "bot-o",
  ], env);
  assert.equal(run.code, 0, run.stderr);
  const id = taskIdFrom(run.stdout);

  const reply = await runCli(["reply", id, "switch to haiku", "--model", "haiku"], env);
  assert.equal(reply.code, 0, reply.stderr);
  const st = statusOf(sandbox, id);
  assert.equal(st.model, "haiku");
  assert.equal(st.runs[1].model, "haiku");

  const calls = callsOf(sandbox);
  assert.ok(hasPair(calls[1].argv, "--model", "haiku"));
  assert.ok(hasPair(calls[1].argv, "--resume", "sess-test-123"));
});

test("is_error in the result record marks the task failed", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const run = await runCli([
    "run", sandbox.cwd, "FAIL this", "--session", "failure", "--model", "haiku", "--owner", "bot-f",
  ], env);
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stdout, /STATE failed/);
  const id = taskIdFrom(run.stdout);

  const st = statusOf(sandbox, id);
  assert.equal(st.state, "failed");
  assert.equal(st.exit_code, 1);
  assert.match(st.error, /FAILED: FAIL this/);
  assert.equal(
    readFileSync(join(sandbox.taskDir, id, "result.md"), "utf8"),
    "FAILED: FAIL this\n",
  );
  assert.ok(eventsOf(sandbox, id).some((e) => e.type === "error"));
});

test("timeout kills the Claude process group and records exit 124", async (t) => {
  const sandbox = makeSandbox(t);
  const env = baseEnv(sandbox);
  const run = await runCli([
    "run", sandbox.cwd, "SLOW timeout", "--session", "timeout", "--model", "haiku",
    "--owner", "bot-t", "--timeout", "1",
  ], env, 20000);
  assert.equal(run.code, 124, run.stderr);
  assert.match(run.stdout, /STATE failed/);
  const id = taskIdFrom(run.stdout);

  const st = statusOf(sandbox, id);
  assert.equal(st.state, "failed");
  assert.equal(st.exit_code, 124);
  assert.equal(st.error, "timeout");
  assert.ok(eventsOf(sandbox, id).some((e) => e.type === "timeout"));
});
