#!/bin/bash
# boot-check.sh <label> <port> <workdir> <cmd...>  -- boot a scratch server, read identity, prove compat dispatch, stop.
LABEL=$1 PORT=$2 WD=$3; shift 3
P=$(cd "$(dirname "$0")" && pwd); H=$P/home-$LABEL; rm -rf $H $P/ws-$LABEL; mkdir -p $H/userdata $P/ws-$LABEL
echo '{"continueThreadsAfterServerUpdate":false}' > $H/userdata/settings.json
UNIT=hh303-boot-$LABEL
systemd-run --user --unit=$UNIT --collect -q -p WorkingDirectory=$WD -E T3CODE_HOME=$H -E PATH=/usr/bin:/bin "$@" serve --port $PORT --host 127.0.0.1 --no-browser
for i in $(seq 1 90); do curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:$PORT/.well-known/t3/environment 2>/dev/null && break; sleep 1; done
echo "[$LABEL] up after ${i}s"
umask 077; ( cd $WD && T3CODE_HOME=$H "$@" auth session issue --base-dir $H --token-only --scope orchestration:read --scope orchestration:operate --scope environment:maintain 2>/dev/null ) | head -1 > $P/token-$LABEL
export T3P_URL=http://127.0.0.1:$PORT T3P_TOKEN=$(cat $P/token-$LABEL)
t3() { ~/.local/node/bin/node $P/t3.mjs "$@"; }
echo "[$LABEL] inventory: $(t3 get /api/orchestration/inventory | grep -o '"runtime":{[^}]*}\|"continueThreadsAfterServerUpdate":{[^}]*}' | tr '\n' ' ')"
NOW=$(date -u +%FT%T.000Z)
t3 post /api/projects/mutate "{\"type\":\"project.create\",\"commandId\":\"$LABEL-p\",\"projectId\":\"$LABEL-proj\",\"title\":\"$LABEL\",\"workspaceRoot\":\"$P/ws-$LABEL\"}" >/dev/null
echo "[$LABEL] compat thread.create: $(t3 post /api/orchestration/dispatch "{\"type\":\"thread.create\",\"commandId\":\"$LABEL-t\",\"threadId\":\"$LABEL-thread\",\"projectId\":\"$LABEL-proj\",\"title\":\"$LABEL\",\"modelSelection\":{\"instanceId\":\"codex\",\"model\":\"default\"},\"runtimeMode\":\"full-access\",\"interactionMode\":\"default\",\"branch\":null,\"worktreePath\":null,\"createdAt\":\"$NOW\"}")"
echo "[$LABEL] compat turn.interrupt (idle): $(t3 post /api/orchestration/dispatch "{\"type\":\"thread.turn.interrupt\",\"commandId\":\"$LABEL-i\",\"threadId\":\"$LABEL-thread\",\"createdAt\":\"$NOW\"}")"
echo "[$LABEL] hub-hold read: $(t3 get /api/orchestration/hub-hold)"
journalctl --user -u $UNIT --no-pager | grep -i -E 'error|cannot find|ERR_|failed to load' | grep -v -i 'keybinding' | head -5 | cut -c1-200
systemctl --user stop $UNIT
