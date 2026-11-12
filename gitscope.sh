#!/bin/sh
# Launch GitScope:  ./gitscope.sh [repo-path] [--port N] [--no-browser]
HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}" exec python3 -m gitscope "$@"
