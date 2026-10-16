#!/bin/bash
# env-desc.sh <label> <port> <workdir> <envfile|-> <cmd...>: boot, print the public environment descriptor and cloud log lines, stop.
LABEL=$1 PORT=$2 WD=$3 ENVF=$4; shift 4
P=$(cd "$(dirname "$0")" && pwd); H=$P/home-$LABEL; rm -rf $H; mkdir -p $H/userdata; echo '{}' > $H/userdata/settings.json
EXTRA=(); [ "$ENVF" != "-" ] && EXTRA=(-p EnvironmentFile=$ENVF)
systemd-run --user --unit=hh303-desc-$LABEL --collect -q -p WorkingDirectory=$WD "${EXTRA[@]}" -E T3CODE_HOME=$H -E PATH=/usr/bin:/bin "$@" serve --port $PORT --host 127.0.0.1 --no-browser
for i in $(seq 1 90); do curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:$PORT/.well-known/t3/environment 2>/dev/null && break; sleep 1; done
curl -fsS --max-time 5 http://127.0.0.1:$PORT/.well-known/t3/environment | python3 -c "import json,sys; d=json.load(sys.stdin); print('[$LABEL]', json.dumps(d, sort_keys=True)[:900])"
sleep 3; journalctl --user -u hh303-desc-$LABEL --no-pager | grep -i -E 'relay|connect|cloud|clerk' | grep -v -i token | head -4 | cut -c30-220
systemctl --user stop hh303-desc-$LABEL
