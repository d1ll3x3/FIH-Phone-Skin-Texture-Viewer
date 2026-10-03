"""English CLI and upload error messages for the local viewer server."""

from contextlib import redirect_stdout
import errno
from http import HTTPStatus
import io
from pathlib import Path
import socket
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import serve


class ServerMessageTests(unittest.TestCase):
    def handler(self, headers=None, path="/api/convert-charm"):
        handler = object.__new__(serve.ViewerHandler)
        handler.path = path
        handler.headers = {"Content-Length": "1"} if headers is None else headers
        handler.rfile = io.BytesIO(b"x")
        handler.server = SimpleNamespace(
            server_port=8765,
            conversion_gate=Mock(acquire=Mock(return_value=True)),
            converter=Mock(return_value={"ready": True}),
        )
        handler._json = Mock()
        handler.send_error = Mock()
        handler.log_error = Mock()
        return handler

    def test_request_validation_errors_are_english(self):
        cases = [
            ({}, "/unknown", HTTPStatus.NOT_FOUND, "Endpoint not found."),
            ({"Origin": "https://example.com"}, "/api/convert-charm", HTTPStatus.FORBIDDEN, "Origin not allowed."),
            ({"Transfer-Encoding": "chunked"}, "/api/convert-charm", HTTPStatus.BAD_REQUEST, "Chunked uploads are not supported."),
            ({}, "/api/convert-charm", HTTPStatus.LENGTH_REQUIRED, "Missing Content-Length."),
            ({"Content-Length": "invalid"}, "/api/convert-charm", HTTPStatus.BAD_REQUEST, "Invalid Content-Length."),
            ({"Content-Length": str(serve.MAX_BUNDLE_BYTES + 1)}, "/api/convert-charm", HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "The bundle exceeds the 64 MB limit."),
            ({"Content-Length": "0"}, "/api/convert-charm", HTTPStatus.BAD_REQUEST, "The bundle is empty."),
        ]
        for headers, path, status, message in cases:
            with self.subTest(message=message):
                handler = self.handler(headers, path)
                handler.do_POST()
                handler._json.assert_called_once_with(status, {"error": message})

    def test_busy_conversion_message_is_english(self):
        handler = self.handler()
        handler.server.conversion_gate.acquire.return_value = False
        handler.do_POST()
        handler._json.assert_called_once_with(HTTPStatus.SERVICE_UNAVAILABLE, {
            "error": "Two conversions are already running. Try again in a few seconds."
        })
        handler.server.conversion_gate.release.assert_not_called()

    def test_failed_conversion_message_is_english(self):
        handler = self.handler()
        handler.server.converter.side_effect = ValueError("Invalid test bundle")
        handler.do_POST()
        handler._json.assert_called_once_with(HTTPStatus.UNPROCESSABLE_ENTITY, {
            "error": "Could not convert the bundle. Check that it contains a charm prefab with supported meshes and textures."
        })
        handler.log_error.assert_called_once_with("Conversion failed (%s)", "ValueError")
        handler.server.conversion_gate.release.assert_called_once()

    def test_upload_failure_messages_are_english(self):
        cases = [
            (io.BytesIO(b""), HTTPStatus.BAD_REQUEST, "The bundle upload is incomplete."),
            (Mock(read=Mock(side_effect=socket.timeout())), HTTPStatus.REQUEST_TIMEOUT, "The bundle upload timed out."),
            (Mock(read=Mock(side_effect=OSError())), HTTPStatus.INTERNAL_SERVER_ERROR, "Could not save the temporary bundle file."),
        ]
        for stream, status, message in cases:
            with self.subTest(message=message):
                handler = self.handler()
                handler.rfile = stream
                handler.do_POST()
                handler._json.assert_called_once_with(status, {"error": message})
                handler.server.conversion_gate.release.assert_called_once()

    def test_missing_file_message_is_english(self):
        handler = self.handler(path="/missing")
        handler._static_path = Mock(side_effect=ValueError("Invalid test path"))
        handler.send_head()
        handler.send_error.assert_called_once_with(HTTPStatus.NOT_FOUND, "File not found")

    def test_unavailable_port_message_is_english(self):
        with patch.object(serve, "ViewerServer", side_effect=OSError(errno.EADDRINUSE, "Port in use")):
            with self.assertRaisesRegex(OSError, "No local port is available"):
                serve.make_server(8765, Mock())

    def test_cli_help_and_invalid_port_are_english(self):
        script = str(Path(serve.__file__).resolve())
        help_result = subprocess.run([sys.executable, script, "--help"], capture_output=True, text=True, timeout=10)
        self.assertEqual(help_result.returncode, 0)
        self.assertIn("Local skin and charm viewer for Flipping is Hard.", help_result.stdout)
        self.assertIn("Open the viewer in your browser.", help_result.stdout)
        invalid_port = subprocess.run([sys.executable, script, "--port", "0"], capture_output=True, text=True, timeout=10)
        self.assertEqual(invalid_port.returncode, 2)
        self.assertIn("The port must be between 1 and 65535.", invalid_port.stderr)

    def test_startup_and_shutdown_messages_are_english(self):
        server = Mock(server_port=8765)
        server.serve_forever.side_effect = KeyboardInterrupt
        output = io.StringIO()
        with patch.object(sys, "argv", ["serve.py"]), patch.object(serve, "make_server", return_value=server), redirect_stdout(output):
            serve.main()
        self.assertEqual(output.getvalue(),
                         "Viewer ready: http://127.0.0.1:8765/\nPress Ctrl+C to stop the server.\n\nServer stopped.\n")
        server.server_close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
