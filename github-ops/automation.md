# GitHub Automation: Issues + Milestones + Kanban

This repository includes an automation workflow at:
- `.github/workflows/sync-learning-issues.yml`
- `.github/scripts/sync_learning_issues.js`

## What it automates
1. **Issues from `/issues/*.md`**
   - Creates or updates GitHub Issues using each markdown file.
   - Uses a source marker so updates stay idempotent.
2. **Labels**
   - Ensures repository labels exist (as defined in script + `github-ops/labels.md`).
3. **Milestones**
   - Ensures milestones exist and assigns each issue by issue number range.
4. **Kanban / Project (Todo, In Progress, Done)**
   - Adds issues to a GitHub Project (Project V2).
   - Maps status using issue state + `in-progress` label:
     - Open issue + no `in-progress` label -> `Todo`
     - Open issue + `in-progress` label -> `In Progress`
     - Closed issue -> `Done`

## Required setup

### 1) Repository Variable(s)
Set these in **Settings -> Secrets and variables -> Actions -> Variables**:
- `PROJECT_OWNER`: org/user that owns the Project V2
- `PROJECT_NUMBER`: project number (integer)

### 2) Repository Secret
Set this in **Settings -> Secrets and variables -> Actions -> Secrets**:
- `GH_PROJECT_TOKEN`: PAT with permissions to manage issues and project items.

Recommended token scopes (classic PAT):
- `repo`
- `project`

For fine-grained PAT, ensure access to:
- repository issues (read/write)
- project read/write for the owner project

## Trigger behavior
- On push to `main` touching issue-planning files: creates/updates issues + labels + milestones.
- On issue events (`opened`, `edited`, `reopened`, `closed`, `labeled`, `unlabeled`): syncs project status.
- On manual `workflow_dispatch`: full sync.

## Operating notes
- Keep issue titles stable in markdown for easier matching.
- Use `in-progress` label to move work to Kanban **In Progress**.
- Closing issue automatically moves it to **Done**.
