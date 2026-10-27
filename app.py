#!/usr/bin/env python3
"""JEV plays Tetris -- demo server.

Serves the static front-end and proxies decision requests to an open-source
JEV-style structured-read decision model (DiffusionGemma / vllm-sr / d3 on
vLLM, via the `structured_server.py` sidecar that exposes POST /v1/systemone).

The front-end never talks to the model endpoint directly: it posts the
compressed board state and candidate-move question here, and this server
forwards it to `<endpoint>/v1/systemone` with the API key as a bearer token,
so the key stays server-side. A reachable decision-model endpoint is required
for the demo to run.

Zero third-party dependencies -- Python 3.10+ standard library only.

    python app.py            # binds 0.0.0.0:8760 (all interfaces)
    PORT=8000 python app.py
"""

import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8760"))
STATIC_DIR = Path(__file__).resolve().parent / "static"
REQUEST_TIMEOUT = float(os.environ.get("JEV_TIMEOUT", "60"))

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def systemone_url(endpoint: str) -> str:
    """Normalise a user-entered endpoint to its /v1/systemone URL.

    Accepts a bare host ("https://api.example.com"), one with a trailing
    "/v1", or the full "/v1/systemone" path, and always lands on the right
    route.
    """
    url = endpoint.strip().rstrip("/")
    if url.endswith("/v1/systemone"):
        return url
    if url.endswith("/v1"):
        return url + "/systemone"
    return url + "/v1/systemone"


class Handler(BaseHTTPRequestHandler):
    server_version = "jev-tetris/1.0"

    def log_message(self, *args):  # keep the console quiet
        pass

    # -- helpers ------------------------------------------------------------
    def _send_json(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path):
        try:
            data = path.read_bytes()
        except OSError:
            return self._send_json(404, {"error": "not found"})
        self.send_response(200)
        self.send_header(
            "content-type", CONTENT_TYPES.get(path.suffix, "application/octet-stream")
        )
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _resolve_static(self, path: str) -> Path | None:
        """Map a URL path to a file under STATIC_DIR, refusing escapes."""
        rel = path.lstrip("/") or "index.html"
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR not in target.parents and target != STATIC_DIR:
            return None
        return target if target.is_file() else None

    # -- routes -------------------------------------------------------------
    def do_GET(self):
        route = self.path.split("?", 1)[0]
        if route in ("/", "/index.html"):
            return self._send_file(STATIC_DIR / "index.html")
        if route == "/health":
            return self._send_json(200, {"status": "ok"})
        target = self._resolve_static(route)
        if target is None:
            return self._send_json(404, {"error": "not found"})
        return self._send_file(target)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/decide":
            return self._send_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            return self._send_json(400, {"error": f"bad request body: {exc}"})
        return self._decide(req)

    def _decide(self, req: dict):
        """Forward one decision to the configured JEV endpoint."""
        endpoint = (req.get("endpoint") or "").strip()
        if not endpoint:
            return self._send_json(400, {"error": "no endpoint configured"})

        payload = req.get("body")
        if not isinstance(payload, dict):
            return self._send_json(400, {"error": "missing decision body"})
        if req.get("model"):
            payload = {**payload, "model": req["model"]}

        url = systemone_url(endpoint)
        data = json.dumps(payload).encode()
        headers = {"content-type": "application/json"}
        api_key = (req.get("apiKey") or "").strip()
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"

        started = time.perf_counter()
        http_req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(http_req, timeout=REQUEST_TIMEOUT) as resp:
                raw = resp.read()
            elapsed_ms = (time.perf_counter() - started) * 1e3
            answer = json.loads(raw)
            return self._send_json(
                200, {"source": "live", "latency_ms": elapsed_ms, "response": answer}
            )
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:500].decode(errors="replace")
            return self._send_json(
                502,
                {
                    "error": f"endpoint returned {exc.code}",
                    "detail": detail,
                    "url": url,
                },
            )
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            return self._send_json(
                502, {"error": f"could not reach endpoint: {exc}", "url": url}
            )
        except json.JSONDecodeError:
            return self._send_json(
                502, {"error": "endpoint did not return JSON", "url": url}
            )


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    where = "all interfaces" if HOST in ("0.0.0.0", "::") else HOST
    print(f"JEV-plays-Tetris demo listening on {HOST}:{PORT} ({where})", flush=True)
    print(f"Open http://<this-host>:{PORT} and enter your decision-model", flush=True)
    print("endpoint / model / api-key in the UI -- a reachable endpoint is", flush=True)
    print("required for the demo to run.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
