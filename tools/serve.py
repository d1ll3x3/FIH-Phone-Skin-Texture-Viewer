"""Local static preview and Unity charm conversion endpoint."""

from __future__ import annotations

import argparse
import errno
import json
import re
import socket
import tempfile
import threading
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent
MAX_BUNDLE_BYTES = 64 * 1024 * 1024


class ViewerServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], converter: Callable[[Path], dict]):
        super().__init__(address, partial(ViewerHandler, directory=str(ROOT)))
        self.converter = converter
        self.conversion_gate = threading.BoundedSemaphore(2)


class ViewerHandler(SimpleHTTPRequestHandler):
    server: ViewerServer

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(30)

    def _json(self, status: int, data: dict) -> None:
        payload = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        port = self.server.server_port
        return origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def _static_path(self) -> Path:
        raw_path = unquote(urlsplit(self.path).path)
        if "\\" in raw_path or "\x00" in raw_path:
            raise ValueError("Invalid path")
        parts = [part for part in raw_path.split("/") if part]
        if any(part.startswith(".") or ":" in part for part in parts):
            raise ValueError("Private or invalid path")
        resolved = ROOT.joinpath(*parts).resolve()
        if resolved != ROOT and ROOT not in resolved.parents:
            raise ValueError("Path is outside preview root")
        if resolved.is_dir():
            resolved = (resolved / "index.html").resolve()
            if ROOT not in resolved.parents:
                raise ValueError("Index is outside preview root")
        return resolved

    def send_head(self):
        if urlsplit(self.path).path == "/api/status":
            payload = json.dumps({"ready": True, "maxBundleBytes": MAX_BUNDLE_BYTES}).encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)
            return None
        try:
            path = self._static_path()
            if not path.is_file():
                raise FileNotFoundError
            file = path.open("rb")
        except (ValueError, OSError):
            self.send_error(HTTPStatus.NOT_FOUND, "Archivo no encontrado")
            return None
        try:
            stat = path.stat()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", self.guess_type(str(path)))
            self.send_header("Content-Length", str(stat.st_size))
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            return file
        except Exception:
            file.close()
            raise

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/api/convert-charm":
            self._json(HTTPStatus.NOT_FOUND, {"error": "Endpoint no encontrado."})
            return
        if not self._same_origin():
            self._json(HTTPStatus.FORBIDDEN, {"error": "Origen no permitido."})
            return
        if self.headers.get("Transfer-Encoding"):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Envio por bloques no admitido."})
            return
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self._json(HTTPStatus.LENGTH_REQUIRED, {"error": "Falta Content-Length."})
            return
        try:
            length = int(length_header)
        except ValueError:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Content-Length invalido."})
            return
        if length > MAX_BUNDLE_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "El bundle supera 64 MB."})
            return
        if length <= 0:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "El bundle esta vacio."})
            return
        if not self.server.conversion_gate.acquire(blocking=False):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Hay dos conversiones en curso. Reintenta en unos segundos."})
            return
        try:
            with tempfile.TemporaryDirectory(prefix="fih-charm-") as temp_dir:
                filename = unquote(self.headers.get("X-Filename", "charm.bundle")).replace("\\", "/").rsplit("/", 1)[-1]
                filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", filename).rstrip(" .")[:180]
                reserved = {"CON", "PRN", "AUX", "NUL"} | {f"{prefix}{index}" for prefix in ("COM", "LPT") for index in range(1, 10)}
                if not filename or filename.split(".")[0].upper() in reserved:
                    filename = "charm.bundle"
                bundle_path = Path(temp_dir) / filename
                remaining = length
                with bundle_path.open("wb") as file:
                    while remaining:
                        block = self.rfile.read(min(1024 * 1024, remaining))
                        if not block:
                            raise ConnectionError("Incomplete upload")
                        file.write(block)
                        remaining -= len(block)
                try:
                    data = self.server.converter(bundle_path)
                    # Validate before writing response headers, including non-finite floats.
                    json.dumps(data, allow_nan=False)
                except Exception as error:
                    self.log_error("Conversion fallida (%s)", type(error).__name__)
                    status = HTTPStatus.UNPROCESSABLE_ENTITY
                    data = {
                        "error": "No se pudo convertir el bundle. Comprueba que contiene un prefab de charm con mallas y texturas compatibles."
                    }
                else:
                    status = HTTPStatus.OK
            self._json(status, data)
        except ConnectionError:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "El bundle se recibio incompleto."})
        except (socket.timeout, TimeoutError):
            self._json(HTTPStatus.REQUEST_TIMEOUT, {"error": "Se agoto el tiempo de subida del bundle."})
        except OSError:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "No se pudo guardar temporalmente el bundle."})
        finally:
            self.server.conversion_gate.release()


def make_server(port: int, converter: Callable[[Path], dict]) -> ViewerServer:
    for candidate in range(port, min(port + 100, 65536)):
        try:
            return ViewerServer(("127.0.0.1", candidate), converter)
        except OSError as error:
            if error.errno not in (errno.EADDRINUSE, errno.EACCES) and getattr(error, "winerror", None) not in (10048, 10013):
                raise
    raise OSError("No se encontro un puerto local disponible.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Visor local de skins y charms de Flipping is Hard.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="Abrir el visor en el navegador.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("El puerto debe estar entre 1 y 65535.")
    try:
        from convert_charm import convert_bundle
    except ImportError:
        parser.exit(1, "Faltan dependencias. Ejecuta start-viewer.ps1 o instala tools/requirements.txt.\n")
    server = make_server(args.port, convert_bundle)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Visor disponible: {url}", flush=True)
    print("Pulsa Ctrl+C para detener el servidor.", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
