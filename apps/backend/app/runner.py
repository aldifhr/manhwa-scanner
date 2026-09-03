"""Uvicorn runner — extracted from main.py:416."""
import sys

import uvicorn


def run(app):
    port = 3000
    if "--port" in sys.argv:
        idx = sys.argv.index("--port")
        if idx + 1 < len(sys.argv):
            port = int(sys.argv[idx + 1])
    uvicorn.run(app, host="127.0.0.1", port=port, workers=1, proxy_headers=True, forwarded_allow_ips="*", loop="uvloop", access_log=False, limit_concurrency=2000, limit_max_requests=10000, timeout_keep_alive=30)
