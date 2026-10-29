// INPUT: Fixed synthetic Endpoint/metadata values and deferred live-verification callbacks.
// OUTPUT: Strict metadata, revisions, identity tombstones and asynchronous race regressions.
// POS: Pure registry tests; no SDK, filesystem, model or host evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMetadataRegistry } from '../../src/registry/metadata.ts';
import { type Endpoint } from '../../src/protocol/message.ts';

const endpoint = (id = 'source', harness: Endpoint['harness'] = 'dsh'): Endpoint => ({ schemaVersion: 1,
  endpointId: id, harness, storageNamespace: 'opaque', nativeSessionId: `native-${id}`,
  hostInstanceId: 'host-1', routeGeneration: 'generation-1' });
const metadata = () => ({ title: '原始标题', titleProvider: 'user' as const,
  workspacePath: '/synthetic/workspace', cwd: '/synthetic/workspace/project', cwdSource: 'session-creation' as const,
  worktreePath: null as string | null, clientSurface: 'desktop' as const });
const create = () => createMetadataRegistry({ verify: async () => {} });
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  assert.fail('verification fixture was not entered');
}

test('observes exact frozen snapshots, copies borrowed objects, and verifies each read', async () => {
  const checked: Endpoint[] = []; const registry = createMetadataRegistry({ verify: async value => { checked.push(value); } });
  const source = { ...endpoint() }; const value = metadata(); const first = await registry.observe(source, value);
  assert.deepEqual(first, { endpoint: source, metadataRevision: 1, metadata: value });
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.endpoint)); assert.ok(Object.isFrozen(first.metadata));
  source.routeGeneration = 'changed'; value.title = 'borrower mutation';
  assert.equal(first.endpoint.routeGeneration, 'generation-1'); assert.equal(first.metadata.title, '原始标题');
  assert.equal(await registry.get('source'), first); assert.deepEqual(await registry.list('dsh'), [first]);
  assert.equal(checked.length, 3); assert.ok(checked.every(Object.isFrozen));
  assert.ok(Object.isFrozen(await registry.list('dsh')));
});

test('identical full metadata preserves revision and object, while any field change increments', async () => {
  const registry = create(); const source = endpoint(); const original = metadata();
  let record = await registry.observe(source, original);
  assert.equal(await registry.observe({ ...source }, { ...original }), record);
  for (const patch of [{ title: '自动标题', titleProvider: 'provider' }, { workspacePath: '/other' },
    { cwd: null }, { worktreePath: '/synthetic/tree' }, { clientSurface: 'cli' }]) {
    const next = await registry.observe(source, { ...record.metadata, ...patch });
    assert.equal(next.metadataRevision, record.metadataRevision + 1); assert.notEqual(next, record); record = next;
  }
});

test('nullable metadata and all fixed provenance/surface values are supported without invented defaults', async () => {
  const registry = create();
  for (const titleProvider of ['host', 'user', 'provider', 'fallback', 'unknown']) {
    const data = { title: null, titleProvider, workspacePath: null, cwd: null, cwdSource: 'unknown', worktreePath: null, clientSurface: 'cli' };
    assert.deepEqual((await registry.observe(endpoint(titleProvider), data)).metadata, data);
  }
  assert.equal((await registry.observe(endpoint('empty-title'), { ...metadata(), title: '' })).metadata.title, '');
});

test('metadata boundary rejects missing unknown malformed fields and nonabsolute paths before verify', async () => {
  let verifies = 0; const registry = createMetadataRegistry({ verify: async () => { verifies++; } });
  const { cwd: _cwd, ...missing } = metadata();
  const cases: unknown[] = [null, [], missing, { ...metadata(), authority: 'user' },
    { ...metadata(), title: 1 }, { ...metadata(), titleProvider: 'model' }, { ...metadata(), clientSurface: 'web' },
    ...['workspacePath', 'cwd', 'worktreePath'].flatMap(key => ['', 'relative', 1, '/bad\0path'].map(value => ({ ...metadata(), [key]: value }))),
    Object.assign(Object.create({ inherited: true }), metadata()), { ...metadata(), [Symbol('hidden')]: 'unknown' }];
  for (const value of cases) await assert.rejects(registry.observe(endpoint(), value), /INVALID_SESSION_METADATA/);
  assert.equal(verifies, 0);
});

test('metadata boundary rejects accessors and hidden properties without evaluating them', async () => {
  const registry = create(); let reads = 0; const accessor = { ...metadata() };
  Object.defineProperty(accessor, 'title', { enumerable: true, get() { reads++; return 'getter'; } });
  await assert.rejects(registry.observe(endpoint(), accessor), /INVALID_SESSION_METADATA/); assert.equal(reads, 0);
  const hidden = { ...metadata() }; Object.defineProperty(hidden, 'extra', { value: 1 });
  await assert.rejects(registry.observe(endpoint(), hidden), /INVALID_SESSION_METADATA/);
});

test('Endpoint parsing rejects forged wire fields and empty identity before verify', async () => {
  let verifies = 0; const registry = createMetadataRegistry({ verify: async () => { verifies++; } });
  for (const [value, code] of [[{ ...endpoint(), endpointId: '' }, /INVALID_TEXT/],
    [{ ...endpoint(), authority: 'user' }, /INVALID_FIELDS/], [{ ...endpoint(), schemaVersion: 2 }, /UNSUPPORTED_SCHEMA/]] as const) {
    await assert.rejects(registry.observe(value as Endpoint, metadata()), code);
  }
  assert.equal(verifies, 0);
});

test('same endpointId cannot replace any bound identity field or native run', async () => {
  const registry = create(); const source = endpoint(); await registry.observe(source, metadata());
  for (const patch of [{ harness: 'claude-code' }, { storageNamespace: 'other' }, { nativeSessionId: 'other' },
    { hostInstanceId: 'other' }, { routeGeneration: 'new-generation' }]) {
    await assert.rejects(registry.observe({ ...source, ...patch } as Endpoint, metadata()), /METADATA_IDENTITY_CONFLICT/);
  }
  assert.equal((await registry.get(source.endpointId)).metadataRevision, 1);
});

test('remove permanently revokes original endpointId, including a new generation', async () => {
  const registry = create(); const source = endpoint(); await registry.observe(source, metadata()); registry.remove(source.endpointId);
  await assert.rejects(registry.get(source.endpointId), /METADATA_REVOKED/);
  for (const candidate of [source, { ...source, routeGeneration: 'new' }]) {
    await assert.rejects(registry.observe(candidate, metadata()), /METADATA_REVOKED/);
  }
  assert.deepEqual(await registry.list('dsh'), []); registry.remove(source.endpointId);
});

test('observe cannot resurrect an endpoint removed while its verification is in flight', async () => {
  const pending = Promise.withResolvers<void>(); let entered = false;
  const registry = createMetadataRegistry({ verify: async () => { entered = true; await pending.promise; } });
  const observed = registry.observe(endpoint(), metadata()); void observed.catch(() => {});
  await until(() => entered); registry.remove('source'); pending.resolve();
  await assert.rejects(observed, /METADATA_REVOKED/); assert.deepEqual(await registry.list('dsh'), []);
});

test('later observe ticket wins and late success cannot overwrite it', async () => {
  const pending = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]; let entered = 0;
  const registry = createMetadataRegistry({ verify: () => pending[entered++].promise });
  const old = registry.observe(endpoint(), metadata()); void old.catch(() => {});
  const latest = registry.observe(endpoint(), { ...metadata(), title: '最新' }); await until(() => entered === 2);
  pending[1].resolve(); const result = await latest; assert.equal(result.metadata.title, '最新'); assert.equal(result.metadataRevision, 1);
  pending[0].resolve(); await assert.rejects(old, /STALE_METADATA_OBSERVATION/);
});

test('a newer failed verification does not let an older pending observation commit', async () => {
  const pending = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]; let entered = 0;
  const registry = createMetadataRegistry({ verify: () => pending[entered++].promise });
  const old = registry.observe(endpoint(), metadata()); void old.catch(() => {});
  const latest = registry.observe(endpoint(), { ...metadata(), title: 'new' }); void latest.catch(() => {});
  await until(() => entered === 2);
  pending[1].reject(new Error('private-identity-error')); await assert.rejects(latest, /METADATA_UNAVAILABLE/);
  pending[0].resolve(); await assert.rejects(old, /STALE_METADATA_OBSERVATION/);
});

test('concurrent observation of a different identity is rejected before verification', async () => {
  const pending = Promise.withResolvers<void>(); let count = 0;
  const registry = createMetadataRegistry({ verify: async () => { count++; await pending.promise; } });
  const original = registry.observe(endpoint(), metadata()); void original.catch(() => {});
  await assert.rejects(registry.observe({ ...endpoint(), routeGeneration: 'other' }, metadata()), /METADATA_IDENTITY_CONFLICT/);
  assert.equal(count, 1); pending.resolve(); assert.equal((await original).metadataRevision, 1);
});

test('get rechecks original record after verify and rejects updates instead of returning stale metadata', async () => {
  let pause = false; let entered = false; const pending = Promise.withResolvers<void>();
  const registry = createMetadataRegistry({ verify: async () => { if (pause) { pause = false; entered = true; await pending.promise; } } });
  await registry.observe(endpoint(), metadata()); pause = true; const read = registry.get('source'); void read.catch(() => {});
  await until(() => entered); await registry.observe(endpoint(), { ...metadata(), title: 'new' }); pending.resolve();
  await assert.rejects(read, /METADATA_CHANGED/); assert.equal((await registry.get('source')).metadata.title, 'new');
});

test('get rejects a record removed during verification', async () => {
  let pause = false; let entered = false; const pending = Promise.withResolvers<void>();
  const registry = createMetadataRegistry({ verify: async () => { if (pause) { entered = true; await pending.promise; } } });
  await registry.observe(endpoint(), metadata()); pause = true; const read = registry.get('source'); void read.catch(() => {});
  await until(() => entered); registry.remove('source'); pending.resolve(); await assert.rejects(read, /METADATA_REVOKED/);
});

test('get and list fail closed on invalid live identity without exposing verify errors', async () => {
  let failed = false; const registry = createMetadataRegistry({ verify: async () => { if (failed) throw new Error('private-sid-and-path'); } });
  await registry.observe(endpoint(), metadata()); failed = true;
  await assert.rejects(registry.get('source'), error => error instanceof Error && error.message === 'METADATA_UNAVAILABLE');
  await assert.rejects(registry.list('dsh'), error => error instanceof Error && error.message === 'METADATA_UNAVAILABLE');
  await assert.rejects(registry.observe(endpoint(), metadata()), /METADATA_UNAVAILABLE/);
  await assert.rejects(registry.observe({ ...endpoint(), routeGeneration: 'new' }, metadata()), /METADATA_IDENTITY_CONFLICT/);
});

test('list hard-filters platform before verification and never returns another Harness', async () => {
  const checked: string[] = []; const registry = createMetadataRegistry({ verify: async value => { checked.push(value.harness); } });
  await registry.observe(endpoint('a', 'dsh'), metadata()); await registry.observe(endpoint('b', 'claude-code'), metadata());
  checked.length = 0; const selected = await registry.list('dsh');
  assert.deepEqual(checked, ['dsh']); assert.deepEqual(selected.map(record => record.endpoint.endpointId), ['a']);
  assert.deepEqual(await registry.list('codex'), []);
  await assert.rejects(registry.list('all' as Endpoint['harness']), /INVALID_METADATA_HARNESS/);
});

test('list rechecks earlier verified records after the slowest verification before returning', async () => {
  let reading = false; let entered = false; const pending = Promise.withResolvers<void>();
  const registry = createMetadataRegistry({ verify: async value => { if (reading && value.endpointId === 'b') { entered = true; await pending.promise; } } });
  await registry.observe(endpoint('a'), metadata()); await registry.observe(endpoint('b'), metadata()); reading = true;
  const listing = registry.list('dsh'); void listing.catch(() => {}); await until(() => entered); registry.remove('a'); pending.resolve();
  await assert.rejects(listing, /METADATA_REVOKED/);
});

test('list rejects metadata changed while another endpoint is being verified', async () => {
  let reading = false; let entered = false; const pending = Promise.withResolvers<void>();
  const registry = createMetadataRegistry({ verify: async value => { if (reading && value.endpointId === 'b') { entered = true; await pending.promise; } } });
  await registry.observe(endpoint('a'), metadata()); await registry.observe(endpoint('b'), metadata()); reading = true;
  const listing = registry.list('dsh'); void listing.catch(() => {}); await until(() => entered);
  await registry.observe(endpoint('a'), { ...metadata(), title: 'renamed' }); pending.resolve();
  await assert.rejects(listing, /METADATA_CHANGED/);
});

test('factory and lookup boundaries reject malformed dependencies or identifiers', async () => {
  assert.throws(() => createMetadataRegistry({ verify: null as never }), /INVALID_METADATA_REGISTRY/);
  const registry = create(); await assert.rejects(registry.get('missing'), /UNKNOWN_METADATA_ENDPOINT/);
  await assert.rejects(registry.get(''), /INVALID_METADATA_ENDPOINT_ID/);
  assert.throws(() => registry.remove(''), /INVALID_METADATA_ENDPOINT_ID/);
});

test('cwd provenance is explicit and cannot claim a live shell directory',async()=>{
 const registry=create();
 for(const cwdSource of ['session-creation','host-metadata','unknown']) assert.equal((await registry.observe(endpoint(cwdSource),{...metadata(),cwdSource})).metadata.cwdSource,cwdSource);
 await assert.rejects(registry.observe(endpoint('bad-cwd-source'),{...metadata(),cwdSource:'live-shell'}),/INVALID_SESSION_METADATA/);
});
