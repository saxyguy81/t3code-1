#!/bin/bash
# hub.sh init|start|stop|token  -- scratch 0.1.0 hub for hanan-work#303 proofs. HOME_DIR is throwaway.
set -euo pipefail
R=${HUB_REPO:-$HOME/Projects/t3code-work/hub-hold-303}
H=${HUB_HOME:-$HOME/work/hh303/proof/home}
PORT=${HUB_PORT:-47303}
UNIT=hh303-hub-$PORT
NODE=$HOME/.local/node/bin/node
case "$1" in
  init)
    mkdir -p "$H/userdata"
    cat > "$H/userdata/settings.json" <<JSON
{"providerInstances":{"mock":{"driver":"acpRegistry","displayName":"Mock","enabled":true,
 "environment":[{"name":"T3_ACP_HANG_PROMPT_FOREVER","value":"1","sensitive":false},
                {"name":"T3_ACP_REQUEST_LOG_PATH","value":"$H/acp-requests.log","sensitive":false}],
 "config":{"source":"local","agentId":"mock","commandPath":"$NODE","commandArgs":["$R/apps/server/scripts/acp-mock-agent.ts"],"authMethodId":"test"}}}
 ${HUB_EXTRA_SETTINGS:-}}
JSON
    ;;
  start)
    systemd-run --user --unit=$UNIT --collect -q -p WorkingDirectory=$R \
      -E T3CODE_HOME="$H" -E PATH="$HOME/.local/node/bin:/usr/bin:/bin" \
      $NODE apps/server/src/bin.ts serve --port $PORT --host 127.0.0.1 --no-browser
    for i in $(seq 1 300); do
      curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:$PORT/.well-known/t3/environment 2>/dev/null && { echo "up after ${i}s"; exit 0; }
      sleep 1
    done
    echo "not up"; journalctl --user -u $UNIT -n 40 --no-pager; exit 1 ;;
  stop)
    systemctl --user stop $UNIT || true ;;
  kill)
    systemctl --user kill -s SIGKILL $UNIT || true ;;
  token)
    cd $R && T3CODE_HOME="$H" $NODE apps/server/src/bin.ts auth session issue --base-dir "$H" --token-only \
      --scope orchestration:read --scope orchestration:operate --scope environment:maintain ;;
  log)
    journalctl --user -u $UNIT -n ${2:-60} --no-pager ;;
esac
