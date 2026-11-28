export interface WorkflowRunInfo {
  id: number;
  name?: string | null;
  path?: string | null;
  event?: string | null;
  conclusion?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  repository?: { full_name?: string | null } | null;
  head_repository?: { full_name?: string | null } | null;
}

export type WorkflowRunValidation =
  | { valid: true }
  | { valid: false; reason: string };

export function isValidWorkflowRunId(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;

  const numericId = Number(value);
  return Number.isSafeInteger(numericId) && numericId > 0;
}

/**
 * Autofix is deliberately limited to failed CI runs for same-repository PRs.
 * The workflow_run trigger is not sufficient authorization by itself because
 * workflow_dispatch can supply an arbitrary run ID.
 */
export function validateAutofixWorkflowRun(
  run: WorkflowRunInfo,
  expectedRepository: string,
): WorkflowRunValidation {
  if (run.repository?.full_name !== expectedRepository) {
    return { valid: false, reason: 'Workflow run does not belong to this repository.' };
  }

  if (run.head_repository?.full_name !== expectedRepository) {
    return { valid: false, reason: 'Fork workflow runs are not eligible for autofix.' };
  }

  if (run.name !== 'CI' || run.path !== '.github/workflows/ci.yml') {
    return { valid: false, reason: 'Only the repository CI workflow may trigger autofix.' };
  }

  if (run.event !== 'pull_request') {
    return { valid: false, reason: 'Autofix is restricted to pull_request CI runs.' };
  }

  if (run.conclusion !== 'failure') {
    return { valid: false, reason: 'The selected CI run did not conclude with failure.' };
  }

  if (!run.head_branch || !run.head_sha || !/^[a-f0-9]{40}$/i.test(run.head_sha)) {
    return { valid: false, reason: 'Workflow run is missing a valid PR branch or head SHA.' };
  }

  return { valid: true };
}
