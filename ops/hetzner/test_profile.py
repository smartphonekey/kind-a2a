# SPDX-License-Identifier: AGPL-3.0-only
"""Model-free guardrails; live host, networking and recovery checks are separate."""
from pathlib import Path
import json
import re
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from jinja2 import Environment, StrictUndefined
import yaml
from acceptance import Check, IMAGE, network_denied, pod

ROOT = Path(__file__).parent


def document(name):
    return yaml.safe_load((ROOT / name).read_text())


class HostProfileTests(unittest.TestCase):
    def test_release_is_immutable_and_not_a_prerelease(self):
        pins = document("versions.yml")
        self.assertRegex(pins["k3s_version"], r"^v1\.35\.\d+\+k3s\d+$")
        for name in ("k3s_sha256", "k3s_installer_sha256"):
            self.assertRegex(pins[name], r"^[a-f0-9]{64}$")

    def test_maintenance_and_ownership_are_explicit(self):
        plays = document("bootstrap.yml")
        guard = next(t for t in plays[0]["tasks"] if t["name"].startswith("Refuse unowned"))
        expressions = " ".join(guard["ansible.builtin.assert"]["that"])
        self.assertIn("maintenance_approved", expressions)
        self.assertIn("kind-a2a/hetzner-v1", expressions)
        self.assertFalse(document("inventory.example.yml")["all"]["children"]["hetzner"]["vars"]["maintenance_approved"])

    def test_admission_has_no_agent_or_identity_bypass(self):
        config = document("files/admission.yaml")["plugins"][0]["configuration"]
        self.assertEqual(config["defaults"]["enforce"], "restricted")
        self.assertEqual(config["exemptions"], {"namespaces": ["kube-system"], "usernames": [], "runtimeClasses": []})

    def test_audit_never_records_bodies(self):
        self.assertEqual(document("files/audit-policy.yaml")["rules"], [{"level": "Metadata"}])

    def test_firewall_does_not_own_the_cni_ruleset(self):
        rules = (ROOT / "files/host-firewall.nft").read_text()
        executable = "\n".join(x for x in rules.splitlines() if not x.lstrip().startswith("#"))
        self.assertNotIn("flush ruleset", executable)
        self.assertIn("type filter hook forward priority -10; policy accept;", executable)
        self.assertIn('iifname != { "cni0", "flannel.1" } drop', executable)
        self.assertIn("policy drop", executable)
        self.assertEqual(re.findall(r"tcp dport (\d+)", executable), ["22"])
        self.assertIn('iifname { "cni0", "flannel.1" } ip saddr 10.42.0.0/16', executable)
        unit = (ROOT / "files/a2a-host-firewall.service").read_text()
        self.assertNotRegex(unit, r"(?m)^ExecStop=")

    def test_secrets_and_downloads_are_protected(self):
        tasks = document("bootstrap.yml")[1]["tasks"]
        for task in tasks:
            download = task.get("ansible.builtin.get_url")
            if download:
                self.assertTrue(download["url"].startswith("https://"))
                self.assertTrue(download["checksum"].startswith("sha256:"))
            target = task.get("ansible.builtin.template", {})
            if target.get("dest") == "/etc/rancher/k3s/config.yaml":
                self.assertEqual(target["mode"], "0600")
        config = (ROOT / "templates/k3s.yaml.j2").read_text()
        self.assertIn("secrets-encryption: true", config)
        self.assertIn('write-kubeconfig-mode: "0600"', config)
        self.assertNotIn("disable-network-policy", config)
        self.assertIn("etcd-snapshot-retention: 12", config)

    def test_rendered_server_configuration_is_structured(self):
        environment = Environment(undefined=StrictUndefined)
        environment.filters["to_json"] = json.dumps
        template = environment.from_string((ROOT / "templates/k3s.yaml.j2").read_text())
        config = yaml.safe_load(template.render(inventory_hostname="a2a-hz-01", ansible_host="192.0.2.10"))
        self.assertEqual(config["node-ip"], "192.0.2.10")
        self.assertEqual(config["tls-san"], ["127.0.0.1"])
        self.assertTrue(config["cluster-init"])
        self.assertEqual(config["disable"], ["traefik", "servicelb"])
        self.assertIn("admission-control-config-file=/etc/rancher/k3s/admission.yaml", config["kube-apiserver-arg"])

    def test_kubernetes_requires_the_firewall(self):
        tasks = document("bootstrap.yml")[1]["tasks"]
        fence = next(t for t in tasks if t["name"] == "Refuse Kubernetes startup without the host firewall")
        self.assertIn("Requires=a2a-host-firewall.service", fence["ansible.builtin.copy"]["content"])
        self.assertIn("After=a2a-host-firewall.service", fence["ansible.builtin.copy"]["content"])

    def test_operator_login_is_verified_before_retiring_root(self):
        tasks = document("bootstrap.yml")[1]["tasks"]
        identity = next(t for t in tasks if t["name"].startswith("Prove the SSH identity"))
        self.assertFalse(identity["become"])
        self.assertEqual(identity["ansible.builtin.command"], "id -un")
        self.assertIn("operator_user", identity["failed_when"])
        root_lock = next(t for t in tasks if t["name"] == "Retire the emailed root password")
        self.assertLess(tasks.index(identity), tasks.index(root_lock))

    def test_first_handler_flush_cannot_start_kubernetes_before_install(self):
        tasks = document("bootstrap.yml")[1]["tasks"]
        first_flush = next(i for i, task in enumerate(tasks) if task.get("ansible.builtin.meta") == "flush_handlers")
        for task in tasks[:first_flush]:
            self.assertNotIn("Restart K3s", task.get("notify", []))

    def test_acceptance_pods_are_restricted_and_resource_bounded(self):
        self.assertRegex(IMAGE, r"@sha256:[a-f0-9]{64}$")
        for server in (False, True):
            fixture = pod("a2a-host-check-test", "server" if server else "allowed", server)
            spec = fixture["spec"]
            self.assertFalse(spec["automountServiceAccountToken"])
            self.assertTrue(spec["securityContext"]["runAsNonRoot"])
            self.assertEqual(spec["securityContext"]["seccompProfile"]["type"], "RuntimeDefault")
            container = spec["containers"][0]
            self.assertEqual(container["securityContext"]["capabilities"]["drop"], ["ALL"])
            self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
            self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
            self.assertIn("limits", container["resources"])
            self.assertEqual(bool(spec.get("volumes")), server)

    def test_denial_requires_network_evidence_not_dns_or_exec_failure(self):
        for message in ("wget: download timed out", "wget: can't connect to remote host: Connection refused"):
            self.assertTrue(network_denied(SimpleNamespace(returncode=1, stderr=message)))
        for code, message in ((0, ""), (1, "wget: bad address"), (127, "wget: not found"), (1, "pod not found")):
            self.assertFalse(network_denied(SimpleNamespace(returncode=code, stderr=message)))

    def test_receipt_cannot_select_a_foreign_host_or_replacement_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "receipt.json"
            args = SimpleNamespace(host="192.0.2.10", node="node", user="operator", key="key", known_hosts="known-hosts", receipt=str(receipt))
            checker = Check(args)
            state = {"host": args.host, "node": args.node, "namespace": "owned", "namespace_uid": "original"}
            receipt.write_text(json.dumps({**state, "host": "192.0.2.11"}))
            with patch.object(checker, "kube") as kube:
                with self.assertRaisesRegex(RuntimeError, "different host"):
                    checker.saved()
                kube.assert_not_called()
            receipt.write_text(json.dumps(state))
            with patch.object(checker, "kube", return_value=SimpleNamespace(stdout=json.dumps({"metadata": {"uid": "replacement"}}))):
                with self.assertRaisesRegex(RuntimeError, "identity changed"):
                    checker.saved()
            with patch.object(checker, "kube", return_value=SimpleNamespace(stdout=json.dumps({"metadata": {"uid": "original"}}))):
                self.assertEqual(checker.saved(), state)

    def test_operator_route_failure_is_not_public_port_denial(self):
        checker = Check(SimpleNamespace(host="192.0.2.10", user="operator", key="key", known_hosts="known-hosts"))
        with patch("acceptance.socket.create_connection", side_effect=OSError("Network is unreachable")):
            with self.assertRaisesRegex(OSError, "unreachable"):
                checker.denied_port(6443)


if __name__ == "__main__":
    unittest.main()
