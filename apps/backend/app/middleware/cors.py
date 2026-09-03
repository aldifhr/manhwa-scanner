"""CORS config — extracted from main.py:80."""
from fastapi.middleware.cors import CORSMiddleware


def add_cors(app):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://fe.aldifhr.fun", "https://scanner.aldifhr.fun", "https://manhwa.aldifhr.fun"],
        allow_origin_regex=r"https://.*\.aldifhr\.fun",
        allow_methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
        allow_headers=["*", "X-CSRF-Token", "Authorization"],
        allow_credentials=True,
        max_age=600,
    )
