const fs = require('fs');
const path = require('path');

const owner = context.repo.owner;
const repo = context.repo.repo;

const LABEL_SPECS = {
  domain: '1D76DB',
  'corporate-credit': '5319E7',
  quiz: '0E8A16',
  'mini-case': 'C2E0C6',
  'deep-dive': 'FBCA04',
  'executive-summary': '0052CC',
  reflection: 'D876E3',
  'priority-high': 'B60205',
  done: '0E8A16',
  'in-progress': 'FBCA04',
};

function issueNumberFromFile(fileName) {
  const m = fileName.match(/^(\d{3})-/);
  return m ? Number(m[1]) : null;
}

function milestoneForIssue(n) {
  if (n === 0) return 'Day 0 - Baseline and System Setup';
  if (n >= 1 && n <= 3) return 'Week 1 - Foundations';
  if (n >= 4 && n <= 6) return 'Week 2 - Credit Analysis';
  if (n >= 7 && n <= 8) return 'Week 3 - Monitoring and Structuring';
  return 'Week 4 - Recovery and Synthesis';
}

function labelsForIssue(n) {
  const labels = ['deep-dive', 'reflection'];
  if (n === 0) labels.push('priority-high');
  if (n >= 4 && n <= 6) labels.push('corporate-credit');
  else labels.push('domain');
  return labels;
}

async function ensureLabels() {
  const existing = await github.paginate(github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
  const names = new Set(existing.map((l) => l.name));

  for (const [name, color] of Object.entries(LABEL_SPECS)) {
    if (names.has(name)) continue;
    await github.rest.issues.createLabel({
      owner,
      repo,
      name,
      color,
      description: 'Managed by issue automation',
    });
  }
}

async function ensureMilestone(title) {
  const milestones = await github.paginate(github.rest.issues.listMilestones, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  const found = milestones.find((m) => m.title === title);
  if (found) return found.number;

  const created = await github.rest.issues.createMilestone({ owner, repo, title });
  return created.data.number;
}

function parseIssueFile(content) {
  const lines = content.split('\n');
  const header = lines.find((l) => l.startsWith('# '));
  if (!header) throw new Error('Issue markdown missing title header');
  const title = header.replace(/^#\s+/, '').trim();
  return { title };
}

async function upsertIssuesFromFiles() {
  const issuesDir = path.join(process.env.GITHUB_WORKSPACE, 'issues');
  const files = fs
    .readdirSync(issuesDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  for (const file of files) {
    const filePath = path.join(issuesDir, file);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const { title } = parseIssueFile(content);
    const n = issueNumberFromFile(file);
    if (n === null) continue;

    const labels = labelsForIssue(n);
    const milestoneTitle = milestoneForIssue(n);
    const milestone = await ensureMilestone(milestoneTitle);
    const marker = `<!-- source-file: issues/${file} -->`;
    const body = `${content}\n\n${marker}`;

    const existing = await github.paginate(github.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'all',
      per_page: 100,
    });
    const match = existing.find(
      (i) => i.title === title || (i.body || '').includes(marker),
    );

    if (match) {
      await github.rest.issues.update({
        owner,
        repo,
        issue_number: match.number,
        title,
        body,
        labels,
        milestone,
      });
      core.info(`Updated issue #${match.number}: ${title}`);
    } else {
      const created = await github.rest.issues.create({
        owner,
        repo,
        title,
        body,
        labels,
        milestone,
      });
      core.info(`Created issue #${created.data.number}: ${title}`);
    }
  }
}

async function syncProjectStatus(issueNodeId, issueNumber) {
  const projectToken = process.env.GH_PROJECT_TOKEN;
  const projectOwner = process.env.PROJECT_OWNER;
  const projectNumber = Number(process.env.PROJECT_NUMBER || '0');

  if (!projectToken || !projectOwner || !projectNumber) {
    core.info('Project sync skipped: GH_PROJECT_TOKEN, PROJECT_OWNER, or PROJECT_NUMBER not set.');
    return;
  }

  const projectClient = github;

  const projectQuery = await projectClient.graphql(
    `query($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
      user(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }`,
    { owner: projectOwner, number: projectNumber },
  );

  const project = projectQuery.organization?.projectV2 || projectQuery.user?.projectV2;
  if (!project) {
    core.warning(`Project ${projectOwner}/${projectNumber} not found.`);
    return;
  }

  const statusField = project.fields.nodes.find((f) => f.name === 'Status');
  if (!statusField) {
    core.warning('Project Status field not found.');
    return;
  }

  const issue = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const hasInProgress = (issue.data.labels || []).some((l) => (typeof l === 'string' ? l : l.name) === 'in-progress');
  const statusName = issue.data.state === 'closed' ? 'Done' : hasInProgress ? 'In Progress' : 'Todo';
  const statusOption = statusField.options.find((o) => o.name === statusName);

  if (!statusOption) {
    core.warning(`Project Status option '${statusName}' not found.`);
    return;
  }

  const itemQuery = await projectClient.graphql(
    `query($projectId: ID!, $issueId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100) {
            nodes {
              id
              content { ... on Issue { id } }
            }
          }
        }
      }
      issue: node(id: $issueId) { ... on Issue { id } }
    }`,
    { projectId: project.id, issueId: issueNodeId },
  );

  const existingItem = itemQuery.node.items.nodes.find((i) => i.content?.id === issueNodeId);
  let itemId = existingItem?.id;

  if (!itemId) {
    const addRes = await projectClient.graphql(
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
          item { id }
        }
      }`,
      { projectId: project.id, contentId: issueNodeId },
    );
    itemId = addRes.addProjectV2ItemById.item.id;
  }

  await projectClient.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item { id }
      }
    }`,
    {
      projectId: project.id,
      itemId,
      fieldId: statusField.id,
      optionId: statusOption.id,
    },
  );

  core.info(`Project status synced for issue #${issueNumber} => ${statusName}`);
}

(async () => {
  await ensureLabels();

  if (context.eventName === 'push' || context.eventName === 'workflow_dispatch') {
    await upsertIssuesFromFiles();
  }

  if (context.payload.issue) {
    const issue = context.payload.issue;
    await syncProjectStatus(issue.node_id, issue.number);
  }
})();
