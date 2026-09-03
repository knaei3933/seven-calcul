#!/bin/sh
set -eu
unset OMX_TMUX_HUD_OWNER OMX_TMUX_HUD_LEADER_PANE
cd '/root/pouch-clacul'
export OMX_TEAM_WORKER='implement-the-approved-pouch-q/worker-1'
export OMX_TEAM_INTERNAL_WORKER='implement-the-approve-57483222/worker-1'
export OMX_LEADER_NODE_PATH='/root/.nvm/versions/node/v24.18.0/bin/node'
export OMX_LEADER_CLI_PATH='/root/.local/share/orca/codex-runtime-home/bin/codex'
export CODEX_HOME='/root/.local/share/orca/codex-runtime-home/home'
export OMX_TEAM_STATE_ROOT='/root/pouch-clacul/.omx/state'
export OMX_TEAM_LEADER_CWD='/root/pouch-clacul'
export OMX_MODEL_INSTRUCTIONS_FILE='/root/pouch-clacul/.omx/state/team/implement-the-approve-57483222/workers/worker-1/AGENTS.md'
export OMX_TEAM_DISPLAY_NAME='implement-the-approved-pouch-q'
export OMX_REPO_ROOT='/root/pouch-clacul'
export OMX_WORKTREE_ROOT='/root/pouch-clacul'
export OMX_GIT_COMMON_DIR='/root/pouch-clacul/.git'
export OMX_WORKTREE_SCOPE='team'
export OMX_CODEGRAPH_MODE='off'
export OMX_CODEGRAPH_REQUESTED_MODE='auto'
exec '/bin/bash' -c 'export PATH='\''/root/.nvm/versions/node/v24.18.0/bin'\'':$PATH
exec '\''/root/.local/share/orca/codex-runtime-home/bin/codex'\'' '\''[--model,glm-5.3-flash]'\'' '\''-c'\'' '\''model_reasoning_effort="medium"'\'' '\''--model'\'' '\''glm-5.3'\'' '\''-c'\'' '\''model_instructions_file="/root/pouch-clacul/.omx/state/team/implement-the-approve-57483222/workers/worker-1/AGENTS.md"'\'' '\''--dangerously-bypass-approvals-and-sandbox'\'''