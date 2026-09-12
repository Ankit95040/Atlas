#!/usr/bin/env node
// Atlas M11 deterministic script-agent fixture (tests only).
//
// A hermetic stand-in for a real coding-agent CLI: performs small,
// argv-driven file operations relative to its working directory (which Atlas
// sets to the assigned workspace) and exits. No network, no dependencies,
// no shell. Atlas observes whatever this script does from Git itself —
// stdout is informational only and never authority.
//
// Modes (repeatable, executed in order: sleep → writes → deletes →
// absolute writes → env print → garbage → commit → fail):
//   --write <rel=content>        write file (mkdir -p parents), rel to cwd
//   --delete <rel>               remove path (force)
//   --sleep <ms>                 wait before doing anything
//   --fail <msg>                 stderr + exit 1 at the end
//   --garbage                    print non-result garbage to stdout
//   --write-absolute <path=content>  write outside cwd (escape-attempt probe)
//   --print-env <NAME>           print `NAME=value` or `NAME=<unset>`
//   --commit <message>           `git add -A` + commit with test identity
//                                (provider-side commit, like FakeWorkerProvider)

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function takeValues(flag) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length) {
      out.push(args[i + 1]);
    }
  }
  return out;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function splitFirst(value, sep) {
  const index = value.indexOf(sep);
  if (index < 0) {
    console.error(`script-agent: expected <path>${sep}<content>, got ${JSON.stringify(value)}`);
    process.exit(2);
  }
  return [value.slice(0, index), value.slice(index + 1)];
}

function runGit(gitArgs, cwd) {
  return new Promise((resolvePromise, reject) => {
    execFile("git", gitArgs, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`script-agent git failed: ${error.message} ${stderr}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

const sleepMs = takeValues("--sleep").map((v) => Number(v));
for (const ms of sleepMs) {
  if (!Number.isInteger(ms) || ms < 0 || ms > 300000) {
    console.error(`script-agent: bad --sleep value: ${JSON.stringify(String(ms))}`);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, ms));
}

for (const spec of takeValues("--write")) {
  const [rel, content] = splitFirst(spec, "=");
  if (rel.length === 0 || rel.startsWith("/") || rel.includes("..")) {
    console.error(`script-agent: --write path must be workspace-relative: ${JSON.stringify(rel)}`);
    process.exit(2);
  }
  const absolute = resolve(process.cwd(), rel);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

for (const rel of takeValues("--delete")) {
  await rm(resolve(process.cwd(), rel), { force: true, recursive: true });
}

for (const spec of takeValues("--write-absolute")) {
  const [path, content] = splitFirst(spec, "=");
  if (!isAbsolute(path)) {
    console.error(`script-agent: --write-absolute needs an absolute path: ${JSON.stringify(path)}`);
    process.exit(2);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

for (const name of takeValues("--print-env")) {
  const value = process.env[name];
  console.log(`${name}=${value === undefined ? "<unset>" : value}`);
}

if (hasFlag("--garbage")) {
  console.log("THIS IS NOT A PROVIDER RESULT { totally: [unstructured, garbage], exit: true }");
}

for (const message of takeValues("--commit")) {
  await runGit(["add", "-A"], process.cwd());
  await runGit(
    [
      "-c",
      "user.email=script-agent@atlas.test",
      "-c",
      "user.name=Atlas Script Agent",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      message,
    ],
    process.cwd(),
  );
}

const failures = takeValues("--fail");
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
