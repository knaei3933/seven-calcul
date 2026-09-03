# New Task Assignment

**Worker:** worker-1
**Task ID:** 3

## Task Description

Review code quality and update documentation for: Implement the approved pouch quotation system. Use .omx/context/pouch-quotation-implementation-20260903T013212Z.md and pouch-quotation-system-design.md. Build UI, calculation core, tests, and browser verification. Follow AGENTS.md.


## Scrum / Team Goal Workflow

Objective: Complete assigned OMX team task 3 with verified evidence, preserving leader-owned audit.

Durable OMX source of truth:
- Existing team task files, task claims, lifecycle events, and leader audit remain the durable artifacts.
- This section is a logical Codex goal handoff only; it does not create separate per-worker goal JSON or leader-audit artifacts.

Source-of-truth rules:
- Existing team task files and claim lifecycle remain authoritative; this worker goal must reference task IDs 3 instead of creating a duplicate task list.
- Claim each task with `omx team api claim-task` before editing; use the task file claim/status as the current assignment record.
- Record completion evidence through `omx team api transition-task-status`; leader audit owns aggregate team completion.

Assigned task/claim references:
- Task 3: Review and document: Implement the approved pouch quotation system. Use .omx/con (status: pending; claim required before work)

Codex goal handoff guidance (truthful fallback only):
1. If goal tools are available in this worker thread, call `get_goal` before creating or completing a goal.
2. Call `create_goal` only when no active goal exists and the explicit worker objective above should become this thread's active objective.
3. Do not claim OMX shell commands mutated Codex goal state; shell/team APIs persist only OMX artifacts and task state.
4. Call `update_goal({status: "complete"})` only after assigned task transitions are complete and verification evidence is present for leader audit.

## Instructions

1. Resolve canonical team state root and read the task file at `<team_state_root>/team/implement-the-approve-57483222/tasks/task-3.json`
2. Task id format:
   - State/MCP APIs use `task_id: "3"` (not `"task-3"`).
3. Request a claim via CLI interop (`omx team api claim-task --json`)
4. Complete the work
5. After completing work, commit your changes before reporting completion:
   `git add -A && git commit -m "task: <task-subject>"`
   This ensures your changes are available for incremental integration into the leader branch.
6. Complete/fail via lifecycle transition API (`omx team api transition-task-status --json`) from `"in_progress"` to `"completed"` or `"failed"` (include `result`/`error`)
7. Use `omx team api release-task-claim --json` only for rollback to `pending`
8. Write `{"state": "idle", "updated_at": "<current ISO timestamp>"}` to your status file


## Team Coordination Gate

Use the lightweight path for independent fan-out: work your assigned scope, keep normal ACK/status updates, and avoid extra ceremony. Activate the coordinated Team Big Five / ATEM-inspired protocol only when task state or wording shows dependencies, shared files/surfaces, handoffs, integration, cross-boundary work, blocked lanes, or changing assumptions.



## Native Subagent Delegation Contract


### Native Subagent Delegation Contract — Task 3

- Delegation mode: auto
- Before doing more than 3 serial repo-search/read commands, spawn up to 3 Codex native subagents using model gpt-5.6-terra, wait for them, then integrate their findings before continuing.
- A parallel probe is required unless there is a documented skip reason.
- Keep subagent work independent, bounded, and inside this worker's task scope.
- Use child report format: bullets.
- If skipped, include `Subagent skip reason:` in your result and explain why serial work was safer or sufficient.

Role/probe subtask candidates:
- Review probe: inspect risks, edge cases, and contract violations.
- Test probe: identify existing coverage and missing regression checks.

Subagent evidence reporting fields:
- Subagents spawned: <count and task names>
- Subagent model: gpt-5.6-terra
- Findings integrated: <brief bullets>
- Serial searches before spawn: <number>

Delegation compliance evidence (required for completion):
- Include exactly one of these lines in the task completion `result` passed to `omx team api transition-task-status`:
  - `Subagent spawn evidence: <count, child task names/thread ids, and what findings were integrated>`
  - `Subagent skip reason: <why serial execution was safer/sufficient>`
- Completion is rejected with `missing_delegation_compliance_evidence` when this broad-task evidence is absent.


## Verification Requirements

## Verification Protocol

Verify the following task is complete: Review code quality and update documentation for: Implement the approved pouch quotation system. Use .omx/context/pouch-quotation-implementation-20260903T013212Z.md and pouch-quotation-system-design.md. Build UI, calculation core, tests, and browser verification. Follow AGENTS.md.

### Required Evidence:

1. Run full type check (tsc --noEmit or equivalent)
2. Run test suite (focus on changed areas)
3. Run linter on modified files
4. Verify the feature/fix works end-to-end
5. Check for regressions in related functionality

Report: PASS/FAIL with command output for each check.

## Fix-Verify Loop

If verification fails:
1. Identify the root cause of each failure
2. Fix the issue (prefer minimal changes)
3. Re-run verification
4. Repeat up to 3 times
5. If still failing after 3 attempts, escalate with:
   - What was attempted
   - What failed and why
   - Recommended next steps

When marking completion, include structured verification evidence in your task result:
- `Verification:`
- One or more PASS/FAIL checks with command/output references

