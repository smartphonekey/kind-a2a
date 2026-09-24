// SPDX-License-Identifier: AGPL-3.0-only
// Trusted-local Lima/local-path backup. Never extracts over installed storage.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const storage = "/var/lib/rancher/k3s/storage";
const hash = value => createHash("sha256").update(value).digest("hex");
export function workspacePaths(claims, volumes, node) {
  assert(claims.length > 0 && claims.length <= 1024, "bounded nonempty claim inventory required");
  const paths = claims.map(claim => {
    assert.equal(claim.status.phase, "Bound");
    assert.equal(claim.spec.storageClassName, "local-path");
    assert(!claim.metadata.deletionTimestamp && !claim.spec.dataSource && !claim.spec.dataSourceRef);
    const pv = volumes.find(v => v.metadata.name === claim.spec.volumeName);
    assert(pv && !pv.metadata.deletionTimestamp && pv.status.phase === "Bound");
    assert.deepEqual([pv.spec.claimRef.uid, pv.spec.claimRef.namespace, pv.spec.claimRef.name],
      [claim.metadata.uid, claim.metadata.namespace, claim.metadata.name], "claim reference changed");
    assert.equal(pv.spec.storageClassName, "local-path");
    assert(Boolean(pv.spec.hostPath) !== Boolean(pv.spec.local), "one local filesystem source required");
    const path = pv.spec.hostPath?.path ?? pv.spec.local?.path;
    assert.equal(path, `${storage}/pvc-${claim.metadata.uid}_${claim.metadata.namespace}_${claim.metadata.name}`,
      "unexpected local-path directory");
    assert(/^[a-z0-9_-]+$/.test(basename(path)), "unsafe storage path");
    const terms = pv.spec.nodeAffinity?.required?.nodeSelectorTerms;
    assert.equal(terms?.length, 1);
    const expressions = terms[0].matchExpressions;
    assert.equal(expressions?.length, 1);
    assert.deepEqual(expressions[0], { key: "kubernetes.io/hostname", operator: "In", values: [node] });
    return basename(path);
  }).sort();
  assert.equal(new Set(paths).size, paths.length, "duplicate source path");
  return paths;
}

function privatePath(path, directory = false) {
  assert(isAbsolute(path));
  const info = lstatSync(path);
  assert((directory ? info.isDirectory() : info.isFile()) && info.uid === process.getuid() && (info.mode & 0o077) === 0,
    "private owned configuration and output required");
}

async function main() {
  assert.equal(process.env.AGYN_LIVE_ACCEPTANCE, "trusted-local");
  const file = process.env.AGYN_WORKSPACE_BACKUP_CONFIG;
  privatePath(file);
  const config = JSON.parse(readFileSync(file, "utf8"));
  privatePath(config.outputRoot, true);
  assert(isAbsolute(config.kubeconfig) && isAbsolute(config.limaHome));
  assert(/^[a-z0-9-]+$/.test(config.instance));
  assert(config.deployments.length >= 5 && config.deployments.every(d => d.uid && d.name && d.namespace));
  assert.equal(config.hostUnit, "aira-a2a-web.service");
  const command = (program, args, input) => execFileSync(program, args, {
    input, encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"]
  });
  const k = args => command("kubectl", ["--kubeconfig", config.kubeconfig, "--request-timeout=30s", ...args]);
  const get = (kind, namespace) => JSON.parse(k(["get", kind, ...(namespace ? ["-n", namespace] : ["-A"]), "-o", "json"]));
  const vmArgs = args => ["shell", config.instance, "sudo", ...args];
  const vmEnv = { ...process.env, LIMA_HOME: config.limaHome };
  const vm = args => execFileSync("limactl", vmArgs(args), { env: vmEnv, encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] });
  const snapshot = () => {
    assert.equal(command("systemctl", ["--user", "show", config.hostUnit, "-p", "ActiveState", "--value"]).trim(), "inactive");
    const deployments = get("deployments").items;
    for (const expected of config.deployments) {
      const d = deployments.find(x => x.metadata.uid === expected.uid && x.metadata.name === expected.name && x.metadata.namespace === expected.namespace);
      assert(d && d.spec.replicas === 0 && (d.status.replicas ?? 0) === 0, "all selected writers must be stopped");
    }
    const nodes = get("nodes").items;
    assert.equal(nodes.length, 1);
    assert(nodes[0].status.conditions.some(c => c.type === "Ready" && c.status === "True"));
    const claims = get("pvc").items.filter(c => config.namespaces.includes(c.metadata.namespace));
    assert.equal(claims.length, config.expectedClaims);
    const volumes = get("pv").items.filter(v => claims.some(c => c.spec.volumeName === v.metadata.name));
    assert.equal(volumes.length, claims.length);
    const paths = workspacePaths(claims, volumes, nodes[0].metadata.name);
    for (const pod of get("pods").items) {
      assert(!pod.spec.volumes?.some(v => v.persistentVolumeClaim && claims.some(c =>
        c.metadata.namespace === pod.metadata.namespace && c.metadata.name === v.persistentVolumeClaim.claimName)), "workspace is still mounted by a Pod");
      assert(!config.deployments.some(d => pod.metadata.namespace === d.namespace &&
        pod.metadata.labels?.["app.kubernetes.io/name"] === d.name), "writer Pod still exists");
    }
    const journals = get("configmaps", config.workloadNamespace);
    return { claims, volumes, paths, journals, node: nodes[0].metadata.name, nodeUid: nodes[0].metadata.uid };
  };
  const before = snapshot();
  assert.deepEqual(vm(["stat", "--format=%F", "--", ...before.paths.map(path => join(storage, path))]).trim().split("\n"),
    before.paths.map(() => "directory"), "workspace roots must be real directories, not links");
  const directory = mkdtempSync(join(config.outputRoot, "workspaces-"));
  const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  save("source.json", before);
  const archive = join(directory, "workspaces.tar");
  const restore = `/tmp/aira-workspace-restore-${randomUUID()}`;
  let stage = "archive", created = false, verified = false, cleanupConfirmed = false;
  const transfer = async (args, source, target) => {
    const child = spawn("limactl", vmArgs(args), { env: vmEnv, stdio: ["pipe", "pipe", "pipe"] });
    let errors = "";
    child.stderr.on("data", b => { errors = (errors + b).slice(-8000); });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`tar transfer failed (${code ?? signal}): ${errors}`)));
    });
    const input = typeof source === "string" ? new Promise((resolve, reject) => {
      child.stdin.once("error", reject); child.stdin.end(source, resolve);
    }) : pipeline(source, child.stdin);
    const output = target ? pipeline(child.stdout, target) : (child.stdout.resume(), Promise.resolve());
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    try { await Promise.all([input, output, done]); }
    catch (error) { child.kill("SIGTERM"); await done.catch(() => {}); throw error; }
    finally { clearTimeout(timer); }
  };
  const compare = root => transfer(["tar", "--compare", "--file=-", "--acls", "--xattrs", "--numeric-owner", "--directory", root], createReadStream(archive));
  try {
    await transfer(["tar", "--create", "--file=-", "--format=pax", "--acls", "--xattrs", "--numeric-owner", "--sparse",
      "--directory", storage, "--null", "--verbatim-files-from", "--files-from=-"], before.paths.join("\0") + "\0",
    createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    stage = "source-compare";
    await compare(storage);
    stage = "restore";
    vm(["mkdir", "--mode=0700", "--", restore]); created = true;
    await transfer(["tar", "--extract", "--file=-", "--acls", "--xattrs", "--numeric-owner", "--same-owner", "--directory", restore], createReadStream(archive));
    stage = "restore-compare";
    await compare(restore);
    await compare(storage);
    const after = snapshot();
    // Ignore collection resource versions; object identities, specifications and
    // authority data must remain exact while the writers are stopped.
    for (const key of ["claims", "volumes", "paths", "node", "nodeUid"]) assert.deepEqual(after[key], before[key]);
    assert.deepEqual(after.journals.items, before.journals.items);
    verified = true;
  } catch (error) {
    save("failure.json", { stage, message: String(error.message).slice(0, 1000) });
    throw new Error(`Workspace backup failed at ${stage}; private evidence: ${directory}`);
  } finally {
    if (created) {
      assert.equal(vm(["stat", "--format=%F:%u:%a", "--", restore]).trim(), "directory:0:700");
      vm(["rm", "-rf", "--one-file-system", "--", restore]);
      try { vm(["test", "!", "-e", restore]); cleanupConfirmed = true; } catch {}
    }
    save("cleanup.json", { restore, created, cleanupConfirmed, verified });
  }
  assert(verified && cleanupConfirmed);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  save("receipt.json", { kind: "local-workspace-restored-backup", version: 1, at: new Date().toISOString(),
    archiveSha256: digest.digest("hex"), bytes: statSync(archive).size, sourceSha256: hash(readFileSync(join(directory, "source.json"))),
    claims: before.claims.length, journals: before.journals.items.length, sourceCompared: true, restoreCompared: true,
    cleanupConfirmed, installedStorageWritten: false, replacementNodeRecoveryTested: false });
  console.log(JSON.stringify({ directory, claims: before.claims.length, bytes: statSync(archive).size, restoreCompared: true, cleanupConfirmed }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
