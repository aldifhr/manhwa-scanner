FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY apps/backend/pyproject.toml apps/backend/requirements.txt ./
RUN uv pip install --system --no-cache-dir -r requirements.txt

COPY apps/backend/ .

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
