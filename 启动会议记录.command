#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
.venv/bin/python scripts/start_service.py || exit 1
open -a 'Google Chrome' http://127.0.0.1:8766
