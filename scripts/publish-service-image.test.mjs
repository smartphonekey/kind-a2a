// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/publish-service-image.yml', import.meta.url), 'utf8');
const step = name => {
  const start = workflow.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `missing step: ${name}`);
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
};

test('publication is limited to main of this repository and never runs for pull requests', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.(?!GITHUB_TOKEN)/);
  assert.ok(step('Select destination').includes("github.repository == 'smartphonekey/kind-a2a' && github.ref == 'refs/heads/main' && github.event_name != 'pull_request'"));
  for (const name of ['Log in to GHCR', 'Refuse to publish into a public package', 'Confirm the package stayed private']) {
    assert.ok(step(name).includes("if: steps.target.outputs.publish == 'true'"), name);
  }
  assert.ok(step('Attest build provenance').includes("steps.target.outputs.publish == 'true' && steps.build.outputs.digest != ''"));
  assert.match(workflow, /IMAGE_PATH: smartphonekey\/aira-a2a-service\n/);
});

test('a commit tag is immutable: lookup errors fail closed and existing images are reported, not rebuilt', () => {
  const lookup = step('Look for an existing commit image');
  assert.ok(lookup.includes('elif grep -qF "$IMAGE_REF: not found"'));
  assert.ok(lookup.includes('Cannot tell whether $IMAGE_REF exists') && lookup.includes('exit 1'));
  for (const name of ['Set up Docker Buildx', 'Build and push']) assert.ok(step(name).includes("if: steps.existing.outputs.digest == ''"), name);
  const build = step('Build and push');
  assert.ok(build.includes('tags: ${{ steps.target.outputs.ref }}') && build.includes('SOURCE_REVISION=${{ github.sha }}'));
  assert.match(workflow, /echo "ref=\$image:\$GITHUB_SHA"/);
  assert.ok(step('Verify and report digest').includes('if [ "$digest" != "$EXPECTED" ]'));
});

test('every action, service and builder image is pinned by digest', () => {
  const uses = [...workflow.matchAll(/uses: ([^\s]+)/g)].map(match => match[1]);
  assert.ok(uses.length >= 5);
  for (const use of uses) assert.match(use, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/, use);
  for (const image of [...workflow.matchAll(/(?:image|BUILDKIT_IMAGE): (docker\.io\/\S+)/g)].map(match => match[1])) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/, image);
  }
});
