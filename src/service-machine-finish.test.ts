// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Message, TaskState, Task } from '@a2a-js/sdk';
import { createServiceApp } from './service/http.js';
import { serviceCard } from './service/card.js';
import { DurableTaskStore } from './service/task-store.js';

const owner = { subject: 'coordinator', tenant: 'fixture', canReconcile: false };
const message = () => Message.fromJSON({ messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'work' }] });

test('machine finish: owner-only closure shares durable semantics and never dispatches a new turn', async t => {
  const store = new DurableTaskStore(':memory:');
  const controller = new AbortController();
  const server = createServer(createServiceApp({ store, card: serviceCard('https://agents.example'), profileId: 'worker',
    signal: controller.signal, authorize: async bearer => bearer === 'Bearer owner' ? owner
      : bearer === 'Bearer other' ? { ...owner, subject: 'other' }
      : bearer === 'Bearer tenant' ? { ...owner, tenant: 'other' } : undefined }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const submission = store.submit(owner, message(), 'worker');
  const finish = (token = 'owner', body: object = {}, origin?: string) => fetch(`${base}/tasks/${submission.task.id}/finish`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body) });
  assert.equal((await finish('missing')).status, 401);
  assert.equal((await finish('other')).status, 404);
  assert.equal((await finish('tenant')).status, 404);
  assert.equal((await finish('owner', {}, 'https://browser.example')).status, 403);
  assert.equal((await finish('owner', { resolution: 'continue' })).status, 400);
  const stateUrl = `${base}/tasks/${submission.task.id}/state`;
  assert.equal((await fetch(stateUrl)).status, 401);
  assert.equal((await fetch(stateUrl, { headers: { authorization: 'Bearer other' } })).status, 404);
  const state = Task.fromJSON(await (await fetch(stateUrl, { headers: { authorization: 'Bearer owner' } })).json());
  assert.equal(state.id, submission.task.id); assert.deepEqual(state.history, []); assert.deepEqual(state.artifacts, []);
  const count = () => store.events(owner, submission.task.id).filter(event => event.kind === 'execution.queued').length;
  const before = count();
  const pending = await finish(); assert.equal(pending.status, 200);
  assert.equal(Task.fromJSON(await pending.json()).metadata?.completionRequested, true);
  assert.equal(count(), before);
  assert.equal(store.execution(submission.execution.id)?.endTask, true);
  const { lease } = store.claim('fixture', 60_000, 1)!;
  store.bind(lease, { instanceId: 'instance', threadId: 'thread', profileId: 'worker' });
  store.beginDispatch(lease); store.dispatched(lease, randomUUID());
  store.report('instance', lease.executionId, { eventId: 'finished', kind: 'outcome', outcome: 'turn_done', message: 'done' });
  store.releasing(lease);
  assert.throws(() => store.settle(lease, { stopped: false }));
  store.settle(lease, { stopped: true });
  for (let n = 0; n < 2; n++) {
    const response = await finish(); assert.equal(response.status, 200);
    const closed = Task.fromJSON(await response.json());
    assert.equal(closed.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(closed.metadata?.resourcesReleased, true);
  }
  assert.equal(count(), before);
  assert.equal(store.events(owner, submission.task.id).filter(event => event.kind === 'task.finish_requested').length, 1);
  assert.equal(store.claim('unexpected', 60_000, 1), undefined);
});
