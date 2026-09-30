# SPDX-License-Identifier: AGPL-3.0-only
"""Disposable host acceptance; preserves fixtures for a separately approved reboot."""
import argparse
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import time
import uuid

IMAGE = "docker.io/library/busybox@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4"


def network_denied(result):
    # kube-router can REJECT rather than DROP; DNS/exec errors are not evidence.
    return result.returncode == 1 and any(message in result.stderr.lower() for message in ("timed out", "connection refused"))


def pod(namespace, name, server=False):
    container = {
        "name": name, "image": IMAGE,
        "command": ["httpd", "-f", "-p", "8080", "-h", "/data"] if server else ["sleep", "86400"],
        "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
        "resources": {"requests": {"cpu": "50m", "memory": "32Mi"}, "limits": {"cpu": "300m", "memory": "128Mi"}},
    }
    spec = {
        "automountServiceAccountToken": False,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
        "containers": [container],
    }
    if server:
        container["volumeMounts"] = [{"name": "data", "mountPath": "/data"}]
        container["readinessProbe"] = {"tcpSocket": {"port": 8080}, "periodSeconds": 2}
        spec["volumes"] = [{"name": "data", "persistentVolumeClaim": {"claimName": "data"}}]
    return {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": name, "namespace": namespace, "labels": {"role": name}}, "spec": spec}


class Check:
    def __init__(self, args):
        self.args = args
        self.ssh = ["ssh", "-i", args.key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                    "-o", f"UserKnownHostsFile={args.known_hosts}", "-o", "ConnectTimeout=10", f"{args.user}@{args.host}"]

    def run(self, command, data=None, check=True):
        result = subprocess.run(self.ssh + [shlex.join(command)], input=data, text=True, capture_output=True, timeout=240)
        if check and result.returncode:
            raise RuntimeError(result.stderr.strip())
        return result

    def kube(self, *args, resource=None, check=True):
        return self.run(["sudo", "-n", "k3s", "kubectl", *args], json.dumps(resource) if resource else None, check)

    def saved(self):
        state = json.loads(Path(self.args.receipt).read_text())
        if state["host"] != self.args.host or state["node"] != self.args.node:
            raise RuntimeError("Receipt belongs to a different host")
        actual = json.loads(self.kube("get", "namespace", state["namespace"], "-o", "json").stdout)
        if actual["metadata"]["uid"] != state["namespace_uid"]:
            raise RuntimeError("Namespace identity changed; refusing to act on replacement resources")
        return state

    def ready(self, state):
        self.kube("-n", state["namespace"], "wait", "pod", "--all", "--for=condition=Ready", "--timeout=180s")

    def request(self, state, client, check=True):
        target = state.get("service_ip", "server")
        return self.kube("-n", state["namespace"], "exec", client, "--", "wget", "-q", "-T", "3", "-O", "-", f"http://{target}:8080/", check=check)

    def matches(self, result, marker):
        if result.returncode != 0 or result.stdout.strip() != marker:
            raise RuntimeError("Canary content or connectivity check failed")

    def denied_port(self, port):
        try:
            connection = socket.create_connection((self.args.host, port), timeout=3)
        except (TimeoutError, ConnectionRefusedError):
            return
        connection.close()
        raise RuntimeError(f"Unexpected public TCP access to port {port}")

    def create(self):
        state = {"host": self.args.host, "node": self.args.node, "namespace": "a2a-host-check-" + uuid.uuid4().hex[:10], "marker": uuid.uuid4().hex,
                 "boot_id": self.run(["cat", "/proc/sys/kernel/random/boot_id"]).stdout.strip()}
        receipt = Path(self.args.receipt)
        receipt.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Never overwrite another run's ownership receipt.
        descriptor = os.open(receipt, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        namespace = state["namespace"]
        created = json.loads(self.kube("create", "-f", "-", "-o", "json", resource={"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}}).stdout)
        state["namespace_uid"] = created["metadata"]["uid"]
        receipt.write_text(json.dumps(state, indent=2))
        resources = [
            {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": "data", "namespace": namespace},
             "spec": {"accessModes": ["ReadWriteOnce"], "storageClassName": "local-path", "resources": {"requests": {"storage": "128Mi"}}}},
            pod(namespace, "server", True), pod(namespace, "allowed"), pod(namespace, "blocked"),
            {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "server", "namespace": namespace},
             "spec": {"type": "NodePort", "selector": {"role": "server"}, "ports": [{"port": 8080, "targetPort": 8080}]}},
        ]
        self.kube("create", "-f", "-", resource={"apiVersion": "v1", "kind": "List", "items": resources})
        self.ready(state)
        self.kube("-n", namespace, "exec", "server", "--", "sh", "-ec", "printf '%s\\n' \"$1\" > /data/index.html", "sh", state["marker"])
        self.kube("-n", namespace, "exec", "allowed", "--", "nslookup", "kubernetes.default.svc.cluster.local")
        for client in ("allowed", "blocked"):
            self.matches(self.request(state, client), state["marker"])
        service = json.loads(self.kube("-n", namespace, "get", "service", "server", "-o", "json").stdout)
        state["node_port"] = service["spec"]["ports"][0]["nodePort"]
        state["service_ip"] = service["spec"]["clusterIP"]
        # Confirm NodePort actually works on-host before treating an external failure as a firewall result.
        result = self.run(["curl", "--fail", "--silent", "--show-error", "--max-time", "5", f"http://{self.args.host}:{state['node_port']}/"])
        self.matches(result, state["marker"])
        self.denied_port(state["node_port"])
        self.denied_port(6443)
        rejected = pod(namespace, "must-be-rejected")
        # Keep the spec valid so this exercises admission, not schema validation.
        rejected["spec"]["containers"][0]["securityContext"]["privileged"] = True
        rejected["spec"]["containers"][0]["securityContext"]["allowPrivilegeEscalation"] = True
        result = self.kube("create", "--dry-run=server", "-f", "-", resource=rejected, check=False)
        if result.returncode == 0 or "violates PodSecurity" not in result.stderr:
            raise RuntimeError("Restricted admission was not proven")
        self.kube("create", "-f", "-", resource={"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
            "metadata": {"name": "server-ingress", "namespace": namespace}, "spec": {"podSelector": {"matchLabels": {"role": "server"}},
            "policyTypes": ["Ingress"], "ingress": [{"from": [{"podSelector": {"matchLabels": {"role": "allowed"}}}], "ports": [{"protocol": "TCP", "port": 8080}]}]}})
        receipt.write_text(json.dumps(state, indent=2))
        self.verify(state)
        self.kube("-n", namespace, "delete", "pod", "server", "--wait=true", "--timeout=90s")
        self.kube("create", "-f", "-", resource=pod(namespace, "server", True))
        self.ready(state)
        self.verify(state)
        print(json.dumps({"namespace": namespace, "checks": "network, admission, public ports, pod replacement and PVC marker passed", "fixturesRetained": True}))

    def verify(self, state):
        self.kube("wait", "node/" + self.args.node, "--for=condition=Ready", "--timeout=180s")
        self.ready(state)
        self.matches(self.request(state, "allowed"), state["marker"])
        for _ in range(15):
            blocked = self.request(state, "blocked", check=False)
            if network_denied(blocked):
                break
            time.sleep(2)
        else:
            raise RuntimeError("NetworkPolicy denial was not proven")
        self.matches(self.request(state, "allowed"), state["marker"])
        self.denied_port(6443)
        self.denied_port(state["node_port"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["create", "verify", "cleanup"])
    for name in ("host", "key", "known-hosts", "receipt"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--user", default="agyn-admin")
    parser.add_argument("--node", required=True)
    parser.add_argument("--after-reboot", action="store_true")
    args = parser.parse_args()
    check = Check(args)
    if check.run(["sudo", "-n", "cat", "/etc/a2a-host-profile"]).stdout.strip() != "kind-a2a/hetzner-v1":
        raise RuntimeError("Host is not owned by this profile")
    if args.mode == "create":
        check.create()
        return
    state = check.saved()
    if args.mode == "cleanup":
        check.kube("delete", "namespace", state["namespace"], "--wait=true", "--timeout=180s")
        print("Owned acceptance namespace removed")
        return
    if args.after_reboot and check.run(["cat", "/proc/sys/kernel/random/boot_id"]).stdout.strip() == state["boot_id"]:
        raise RuntimeError("Host has not rebooted since this fixture was created")
    check.verify(state)
    print(json.dumps({"namespace": state["namespace"], "afterReboot": args.after_reboot, "checks": "passed"}))


if __name__ == "__main__":
    main()
