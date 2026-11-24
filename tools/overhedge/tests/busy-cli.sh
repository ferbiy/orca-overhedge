#!/bin/bash
# Test stub: orca-ide with `agent list` reporting one working chat; everything else passes through.
if [ "$1 $2" = "agent list" ]; then
  echo '{"ok":true,"result":{"agents":[{"kind":"chat","agent":"claude","state":"working","orcaSessionId":"test-chat"}]}}'
  exit 0
fi
exec orca-ide "$@"
