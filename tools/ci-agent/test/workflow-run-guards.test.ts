import { describe, expect, it } from 'vitest';
import {
  isValidWorkflowRunId,
  validateAutofixWorkflowRun,
  type WorkflowRunInfo,
} from '../src/workflow-run-guards.js';

const repository = 'shubhamtaywade82/ollama-sdk';

const validRun: WorkflowRunInfo = {
  id: 12345,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  event: 'pull_request',
  conclusion: 'failure',
  head_branch: 'feature/change',
  head_sha: '0123456789abcdef0123456789abcdef01234567',
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};

describe('workflow-run-guards', () => {
  it('accepts only positive safe numeric workflow run IDs', () => {
    expect(isValidWorkflowRunId('12345')).toBe(true);
    expect(isValidWorkflowRunId('0')).toBe(false);
    expect(isValidWorkflowRunId('-1')).toBe(false);
    expect(isValidWorkflowRunId('1; echo unsafe')).toBe(false);
    expect(isValidWorkflowRunId('1.2')).toBe(false);
    expect(isValidWorkflowRunId('9007199254740992')).toBe(false);
  });

  it('accepts a failed CI run for a same-repository pull request', () => {
    expect(validateAutofixWorkflowRun(validRun, repository)).toEqual({ valid: true });
  });

  it('rejects runs from another repository or a fork', () => {
    expect(
      validateAutofixWorkflowRun(
        { ...validRun, repository: { full_name: 'someone/else' } },
        repository,
      ).valid,
    ).toBe(false);
    expect(
      validateAutofixWorkflowRun(
        { ...validRun, head_repository: { full_name: 'contributor/fork' } },
        repository,
      ).valid,
    ).toBe(false);
  });

  it('rejects non-CI workflows, push runs, and successful runs', () => {
    expect(
      validateAutofixWorkflowRun({ ...validRun, name: 'Release Please' }, repository).valid,
    ).toBe(false);
    expect(
      validateAutofixWorkflowRun(
        { ...validRun, path: '.github/workflows/release-please.yml' },
        repository,
      ).valid,
    ).toBe(false);
    expect(validateAutofixWorkflowRun({ ...validRun, event: 'push' }, repository).valid).toBe(
      false,
    );
    expect(
      validateAutofixWorkflowRun({ ...validRun, conclusion: 'success' }, repository).valid,
    ).toBe(false);
  });

  it('rejects incomplete run metadata', () => {
    expect(
      validateAutofixWorkflowRun({ ...validRun, head_sha: 'not-a-sha' }, repository).valid,
    ).toBe(false);
    expect(validateAutofixWorkflowRun({ ...validRun, head_branch: null }, repository).valid).toBe(
      false,
    );
  });
});
