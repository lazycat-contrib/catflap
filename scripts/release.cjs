const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function profile() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../.github/lpk-profile.json'), 'utf8'));
}

function validateRun(run, repository, branch, workflowID, tagPrefix) {
  const tagged = tagPrefix && run.head_branch?.startsWith(tagPrefix) && stableVersion.test(run.head_branch.slice(tagPrefix.length));
  if (run.workflow_id !== workflowID || !(run.head_branch === branch || tagged) ||
      run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !['push', 'workflow_dispatch'].includes(run.event) || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Expected a successful trusted source workflow, branch or stable tag; PR/fork builds are rejected');
  }
}

async function selectSource({github, core}) {
  const config = profile();
  const repository = process.env.SOURCE_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Set the LPK_SOURCE_REPOSITORY Actions secret');
  const [owner, repo] = repository.split('/');
  const branch = process.env.SOURCE_BRANCH || 'main';
  const workflow = await github.rest.actions.getWorkflow({owner, repo, workflow_id: config.workflow});
  const requested = process.env.SOURCE_RUN_ID || '';
  let candidates;
  if (requested) {
    if (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(Number(requested))) throw new Error('Invalid source run ID');
    candidates = [(await github.rest.actions.getWorkflowRun({owner, repo, run_id: Number(requested)})).data];
  } else {
    candidates = (await github.rest.actions.listWorkflowRuns({owner, repo, workflow_id: workflow.data.id, status: 'success', per_page: 30})).data.workflow_runs;
  }
  for (const run of candidates) {
    try { validateRun(run, repository, branch, workflow.data.id, config.tagPrefix); }
    catch (error) { if (requested) throw error; continue; }
    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {owner, repo, run_id: run.id, per_page: 100});
    const matches = artifacts.filter(artifact => !artifact.expired && artifact.name.startsWith(config.artifactPrefix) && stableVersion.test(artifact.name.slice(config.artifactPrefix.length)));
    if (matches.length !== 1) { if (requested) throw new Error('Expected exactly one unexpired LPK artifact'); continue; }
    const version = matches[0].name.slice(config.artifactPrefix.length);
    if (run.head_branch !== branch && run.head_branch !== config.tagPrefix + version) throw new Error('Artifact version differs from the source tag');
    if (matches[0].workflow_run?.head_sha && matches[0].workflow_run.head_sha !== run.head_sha) throw new Error('Artifact does not belong to the selected source commit');
    core.setOutput('available', 'true');
    core.setOutput('run-id', String(run.id));
    core.setOutput('artifact-name', matches[0].name);
    core.setOutput('version', version);
    core.setOutput('package-id', config.packageId);
    core.setOutput('tag', config.tagPrefix + version);
    return;
  }
  core.setOutput('available', 'false');
  core.notice('No unexpired LPK is available; waiting for the next build.');
}

async function ensureAsset(github, owner, repo, releaseID, existing, name, bytes) {
  const wanted = crypto.createHash('sha256').update(bytes).digest('hex');
  let asset = existing.find(candidate => candidate.name === name);
  if (!asset) {
    asset = (await github.rest.repos.uploadReleaseAsset({
      owner, repo, release_id: releaseID, name, data: bytes,
      headers: {'content-type': 'application/octet-stream', 'content-length': bytes.length},
    })).data;
  }
  const response = await github.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
    owner, repo, asset_id: asset.id, headers: {accept: 'application/octet-stream'},
  });
  const actual = crypto.createHash('sha256').update(Buffer.from(response.data)).digest('hex');
  if (wanted !== actual) throw new Error(`Release asset ${name} differs from the verified bytes; existing assets are never overwritten`);
  return asset;
}

async function publishedAssetURL(github, owner, repo, assetID, tag, filename) {
  const {data: asset} = await github.rest.repos.getReleaseAsset({owner, repo, asset_id: assetID});
  const url = new URL(asset.browser_download_url);
  const expected = `/${owner}/${repo}/releases/download/${tag}/${filename}`;
  if (url.origin !== (process.env.GITHUB_SERVER_URL || 'https://github.com') ||
      decodeURIComponent(url.pathname) !== expected || url.search || url.hash) {
    throw new Error('Release asset does not have the expected published version URL');
  }
  return asset.browser_download_url;
}

async function findRelease(github, owner, repo, tag) {
  try {
    return (await github.rest.repos.getReleaseByTag({owner, repo, tag})).data;
  } catch (error) {
    if (error.status !== 404) throw error;
    const releases = await github.paginate(github.rest.repos.listReleases, {owner, repo, per_page: 100});
    const matches = releases.filter(release => release.tag_name === tag);
    if (matches.length > 1) throw new Error('Multiple Releases exist for the same tag');
    return matches[0];
  }
}

async function publishRelease({github, context, core}) {
  const {owner, repo} = context.repo;
  const version = process.env.LPK_VERSION;
  if (!stableVersion.test(version || '')) throw new Error('Invalid stable release version');
  const config = profile();
  const tag = config.tagPrefix + version;
  const lpk = fs.readFileSync(process.env.LPK_PATH);
  if (crypto.createHash('sha256').update(lpk).digest('hex') !== process.env.LPK_SHA256) throw new Error('Local LPK changed after validation');
  let release = await findRelease(github, owner, repo, tag);
  if (!release) {
    const notesPath = path.join(__dirname, '../releases', `${tag}.md`);
    const body = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : `${config.name} ${tag}\n\n提供 LPK 安装包及 SHA256 校验文件。`;
    if (!body) throw new Error('Release notes must not be empty');
    release = (await github.rest.repos.createRelease({
      owner, repo, tag_name: tag, target_commitish: context.sha, draft: true,
      name: `${config.name} ${tag}`, body, prerelease: false, make_latest: 'legacy',
    })).data;
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {owner, repo, release_id: release.id, per_page: 100});
  const filename = `${config.packageId}-v${version}.lpk`;
  const asset = await ensureAsset(github, owner, repo, release.id, assets, filename, lpk);
  await ensureAsset(github, owner, repo, release.id, assets, 'checksums.txt', fs.readFileSync(path.join(path.dirname(process.env.LPK_PATH), 'checksums.txt')));
  if (release.draft) release = (await github.rest.repos.updateRelease({owner, repo, release_id: release.id, draft: false, make_latest: 'legacy'})).data;
  core.setOutput('download-url', await publishedAssetURL(github, owner, repo, asset.id, tag, filename));
  core.setOutput('changelog', release.body || `Release ${version}`);
  core.summary.addHeading('LPK published').addTable([
    [{data: 'Package', header: true}, {data: 'Version', header: true}, {data: 'SHA256', header: true}],
    [config.packageId, version, process.env.LPK_SHA256],
  ]).addLink('GitHub Release', release.html_url);
  await core.summary.write();
}

module.exports = {profile, validateRun, selectSource, ensureAsset, publishedAssetURL, findRelease, publishRelease};
