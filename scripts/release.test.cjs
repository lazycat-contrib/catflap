const {test} = require('node:test');
const assert = require('node:assert/strict');
const {profile, validateRun, selectSource, ensureAsset, publishedAssetURL, findRelease} = require('./release.cjs');

const trusted = {id: 7, workflow_id: 42, head_branch: 'v0.2.10', head_sha: 'source-sha', head_repository: {full_name: 'owner/private'}, event: 'push', status: 'completed', conclusion: 'success'};

test('publication profile contains runtime files only', () => {
  assert.equal(profile().packageId, 'community.lazycat.app.catflap');
  assert.equal(profile().workflow, 'release.yml');
  assert.deepEqual(profile().contentFiles, ['catflapd', 'THIRD_PARTY_NOTICES.md', 'build-info.txt']);
});

test('accepts only a trusted successful stable build or manual branch build', () => {
  validateRun(trusted, 'owner/private', 'main', 42, 'v');
  validateRun({...trusted, event: 'workflow_dispatch', head_branch: 'main'}, 'owner/private', 'main', 42, 'v');
  for (const changed of [{event: 'pull_request'}, {event: 'pull_request_target'}, {head_branch: 'feature'}, {head_branch: 'v0.2.10-rc.1'}, {head_branch: 'v00.2.10'}, {workflow_id: 10}, {conclusion: 'failure'}, {status: 'in_progress'}, {head_repository: {full_name: 'other/fork'}}]) {
    assert.throws(() => validateRun({...trusted, ...changed}, 'owner/private', 'main', 42, 'v'));
  }
});

function sourceHarness(testContext, run = trusted, artifacts = [{name: 'catflap-lpk-v0.2.10', expired: false, workflow_run: {head_sha: 'source-sha'}}]) {
  const previous = {repository: process.env.SOURCE_REPOSITORY, run: process.env.SOURCE_RUN_ID};
  process.env.SOURCE_REPOSITORY = 'owner/private';
  process.env.SOURCE_RUN_ID = '7';
  testContext.after(() => {
    for (const [name, value] of [['SOURCE_REPOSITORY', previous.repository], ['SOURCE_RUN_ID', previous.run]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const outputs = {};
  const github = {rest: {actions: {
    getWorkflow: async () => ({data: {id: 42}}),
    getWorkflowRun: async () => ({data: run}),
    listWorkflowRuns: async () => ({data: {workflow_runs: [run]}}),
    listWorkflowRunArtifacts: async () => {},
  }}, paginate: async () => artifacts};
  const core = {setOutput: (name, value) => { outputs[name] = value; }, notice: () => {}};
  return {github, core, outputs};
}

test('selected artifact identity is tied to the successful source run', async testContext => {
  const harness = sourceHarness(testContext);
  await selectSource(harness);
  assert.equal(harness.outputs.available, 'true');
  assert.equal(harness.outputs.version, '0.2.10');
  assert.equal(harness.outputs.tag, 'v0.2.10');
});

test('expired artifacts stop explicit publication', async testContext => {
  const harness = sourceHarness(testContext, trusted, [{name: 'catflap-lpk-v0.2.10', expired: true}]);
  await assert.rejects(() => selectSource(harness), /unexpired/);
});

test('missing artifacts stop explicit publication', async testContext => {
  const harness = sourceHarness(testContext, trusted, []);
  await assert.rejects(() => selectSource(harness), /exactly one/);
});

test('ambiguous artifacts stop explicit publication', async testContext => {
  const harness = sourceHarness(testContext, trusted, [{name: 'catflap-lpk-v0.2.10', expired: false}, {name: 'catflap-lpk-v0.2.9', expired: false}]);
  await assert.rejects(() => selectSource(harness), /exactly one/);
});

test('tag and artifact version cannot disagree', async testContext => {
  const harness = sourceHarness(testContext, trusted, [{name: 'catflap-lpk-v0.2.9', expired: false}]);
  await assert.rejects(() => selectSource(harness), /version differs/);
});

test('artifact source commit cannot disagree', async testContext => {
  const harness = sourceHarness(testContext, trusted, [{name: 'catflap-lpk-v0.2.10', expired: false, workflow_run: {head_sha: 'another-sha'}}]);
  await assert.rejects(() => selectSource(harness), /source commit/);
});

test('scheduled poll with no retained artifact does not publish', async testContext => {
  const harness = sourceHarness(testContext, trusted, []);
  delete process.env.SOURCE_RUN_ID;
  await selectSource(harness);
  assert.equal(harness.outputs.available, 'false');
});

test('same-version remote asset is never overwritten with different bytes', async () => {
  const github = {request: async () => ({data: Buffer.from('old bytes')})};
  await assert.rejects(() => ensureAsset(github, 'owner', 'public', 10, [{id: 1, name: 'app.lpk'}], 'app.lpk', Buffer.from('new bytes')), /never overwritten/);
});

test('existing asset reuse checks remote bytes instead of trusting metadata', async () => {
  const github = {request: async () => ({data: Buffer.from('same bytes')})};
  const asset = await ensureAsset(github, 'owner', 'public', 10, [{id: 1, name: 'app.lpk'}], 'app.lpk', Buffer.from('same bytes'));
  assert.equal(asset.id, 1);
});

test('new uploads are also read back', async () => {
  const github = {rest: {repos: {uploadReleaseAsset: async () => ({data: {id: 2}})}}, request: async () => ({data: Buffer.from('corrupt')})};
  await assert.rejects(() => ensureAsset(github, 'owner', 'public', 10, [], 'app.lpk', Buffer.from('wanted')), /differs/);
});

test('only a canonical published URL can reach the store', async () => {
  const canonical = 'https://github.com/owner/public/releases/download/v0.2.10/app.lpk';
  const github = {rest: {repos: {getReleaseAsset: async () => ({data: {browser_download_url: canonical}})}}};
  assert.equal(await publishedAssetURL(github, 'owner', 'public', 17, 'v0.2.10', 'app.lpk'), canonical);
  for (const invalid of [canonical.replace('v0.2.10', 'untagged-123'), canonical.replace('github.com', 'example.com'), canonical + '?token=secret', canonical + '#fragment']) {
    github.rest.repos.getReleaseAsset = async () => ({data: {browser_download_url: invalid}});
    await assert.rejects(() => publishedAssetURL(github, 'owner', 'public', 17, 'v0.2.10', 'app.lpk'), /published version URL/);
  }
});

test('a draft invisible to get-by-tag is reused instead of creating a duplicate', async () => {
  const draft = {id: 12, tag_name: 'v0.2.10', draft: true};
  const github = {rest: {repos: {getReleaseByTag: async () => { throw Object.assign(new Error('missing'), {status: 404}); }, listReleases: async () => {}}}, paginate: async () => [draft]};
  assert.equal(await findRelease(github, 'owner', 'public', 'v0.2.10'), draft);
  github.paginate = async () => [draft, {...draft, id: 13}];
  await assert.rejects(() => findRelease(github, 'owner', 'public', 'v0.2.10'), /Multiple/);
});

test('network failures do not become missing releases', async () => {
  const github = {rest: {repos: {getReleaseByTag: async () => { throw Object.assign(new Error('unavailable'), {status: 503}); }}}};
  await assert.rejects(() => findRelease(github, 'owner', 'public', 'v0.2.10'), /unavailable/);
});
