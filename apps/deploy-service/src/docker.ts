/**
 * Runs one untrusted build inside a locked-down, throwaway Docker container.
 * Flow per build: docker create (limits, no secrets) → docker start -a (stream logs,
 * enforce timeout) → docker inspect (exit code / OOM) → docker cp the output → docker rm.
 * Also: boot checks (daemon up, builder image present), cleanup of containers left
 * by a crashed previous run, and abortAllBuilds() for graceful shutdown.
 *
 * This file is the only place that knows builds run on local Docker. Moving builds
 * to ECS Fargate later means replacing this file, not the worker.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { GITHUB_URL_REGEX, type DeployJob } from "@repo/shared";
import { env } from "./env";
import { BuildError } from "./errors";

// Every build container carries this label, so we can find and remove them all
const BUILD_LABEL = "vercel-clone.build";
const OUTPUT_DIR_IN_CONTAINER = "/home/node/output";

// Exit codes defined by builder/build.sh
const EXIT_MESSAGES: Record<number, string> = {
  10: "No package.json at the repository root",
  11: "Build produced no dist/, build/ or out/ folder containing index.html",
  127: "A command in the build script was not found (is it a monorepo, or a missing dependency?)",
};

let aborting = false;

interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs the docker CLI with an argument array. Never a shell string: arguments
// can't be interpreted as extra commands, whatever they contain.
function docker(args: string[]): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject); // docker binary not found
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function dockerOrThrow(args: string[]): Promise<string> {
  const res = await docker(args);
  if (res.code !== 0) throw new Error(`docker ${args[0]} failed (${res.code}): ${res.stderr || res.stdout}`);
  return res.stdout;
}

export async function assertDockerReady() {
  try {
    await dockerOrThrow(["version", "--format", "{{.Server.Version}}"]);
  } catch {
    console.error("[deploy-service] cannot talk to the Docker daemon. Is Docker Desktop running?");
    process.exit(1);
  }
  const image = await docker(["image", "inspect", env.BUILDER_IMAGE]);
  if (image.code !== 0) {
    console.error(`[deploy-service] builder image "${env.BUILDER_IMAGE}" not found.`);
    console.error("Build it with: pnpm --filter deploy-service builder:build");
    process.exit(1);
  }
}

// Assumes one deploy-service process per Docker host: anything carrying our
// label at boot belongs to a previous run that died mid-build.
export async function removeLeftoverContainers() {
  const ids = (await dockerOrThrow(["ps", "-aq", "--filter", `label=${BUILD_LABEL}`])).split(/\s+/).filter(Boolean);
  if (ids.length === 0) return;
  await docker(["rm", "-f", ...ids]);
  console.log(`[docker] removed ${ids.length} leftover build container(s)`);
}

// Graceful shutdown: kill every running build. runBuild() sees `aborting` and
// throws a plain Error (infra), so the job is NOT marked failed and gets retried.
export async function abortAllBuilds() {
  aborting = true;
  const ids = (await docker(["ps", "-q", "--filter", `label=${BUILD_LABEL}`])).stdout.split(/\s+/).filter(Boolean);
  if (ids.length > 0) await docker(["kill", ...ids]);
}

function tarballUrl(job: DeployJob) {
  const match = GITHUB_URL_REGEX.exec(job.repoUrl);
  if (!match) throw new Error(`invalid repoUrl in job: ${job.repoUrl}`); // shouldn't happen, job is validated
  return `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${job.sha}`;
}

// Runs `docker start -a`, forwarding each output line to onLog. Resolves when the
// container stops; kills it if it runs past the timeout.
function attachAndWait(name: string, onLog: (line: string) => void): Promise<{ timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["start", "-a", name], { windowsHide: true });
    readline.createInterface({ input: child.stdout }).on("line", onLog);
    readline.createInterface({ input: child.stderr }).on("line", onLog);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void docker(["kill", name]);
    }, env.BUILD_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ timedOut });
    });
  });
}

// Builds `job` and copies its static output into outDir (an empty local folder).
// Throws BuildError when the user's project is at fault, Error for anything else.
export async function runBuild(job: DeployJob, outDir: string, onLog: (line: string) => void) {
  const name = `build-${job.id}`;

  // A crashed earlier attempt of this same job may have left its container behind
  await docker(["rm", "-f", name]);

  await dockerOrThrow([
    "create",
    "--name", name,
    "--label", `${BUILD_LABEL}=1`,
    "--memory", env.BUILD_MEMORY,
    "--memory-swap", env.BUILD_MEMORY, // same as memory → no extra swap
    "--cpus", env.BUILD_CPUS,
    "--pids-limit", "512", // no fork bombs
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    // The ONLY value passed in. Never `-e NAME` without "=value": Docker would copy it from our env.
    "-e", `TARBALL_URL=${tarballUrl(job)}`,
    env.BUILDER_IMAGE,
  ]);

  try {
    const { timedOut } = await attachAndWait(name, onLog);
    if (aborting) throw new Error("build aborted: deploy-service is shutting down");

    const [exitCode, oomKilled] = (await dockerOrThrow(["inspect", "-f", "{{.State.ExitCode}} {{.State.OOMKilled}}", name])).split(" ");
    const code = Number(exitCode);

    if (timedOut) throw new BuildError(`Build timed out after ${Math.round(env.BUILD_TIMEOUT_MS / 60_000)} minutes`);
    if (oomKilled === "true") throw new BuildError(`Build ran out of memory (limit ${env.BUILD_MEMORY})`);
    if (code !== 0) throw new BuildError(EXIT_MESSAGES[code] ?? `Build failed (exit code ${code})`);

    // Trailing "/." copies the folder's contents, not the folder itself
    await dockerOrThrow(["cp", `${name}:${OUTPUT_DIR_IN_CONTAINER}/.`, outDir]);
  } finally {
    await docker(["rm", "-f", name]);
  }
}
