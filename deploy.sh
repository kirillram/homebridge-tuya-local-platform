#!/bin/bash
set -e

SSH=(ssh -F "${HOME}/.ssh/config" -o ConnectTimeout=10)
RSYNC_SSH="ssh -F ${HOME}/.ssh/config -o ConnectTimeout=10"

echo "Checking connection to pi..."
if ! "${SSH[@]}" -o BatchMode=yes pi true; then
	echo "Cannot reach pi. From this same terminal, run:"
	echo "  ssh pi"
	echo "If that works here but deploy still fails, run deploy from that terminal instead of Cursor."
	exit 1
fi

bun run build
rsync -a --delete -e "$RSYNC_SSH" . pi:~/homebridge-tuya-local-platform/

echo "Deploy complete."
