#!/bin/bash
cd /root/projects/manhwa-backend
export ROLE=api
export BACKEND_URL=https://scanner.aldifhr.fun
export PYTHONPATH=/root/projects/manhwa-backend
exec .venv/bin/python app/main.py --port 3000
