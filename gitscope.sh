#!/bin/sh
# Launch GitScope:  ./gitscope.sh [path-or-url] [--port N] [--offline] [--no-browser]
HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}" exec python3 -m gitscope "$@"
