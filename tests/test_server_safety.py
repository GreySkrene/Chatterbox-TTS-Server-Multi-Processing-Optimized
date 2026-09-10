"""Lightweight regression checks for server helpers without loading the TTS model."""

import ast
import os
import re
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any

from audiobook import reserve_filename


SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"


def load_server_helper(name: str):
    tree = ast.parse(SERVER_PATH.read_text(encoding="utf-8"))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    module = ast.Module(body=[function], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {
        "Any": Any,
        "Path": Path,
        "os": os,
        "re": re,
        "reserve_filename": reserve_filename,
        "uuid": uuid,
    }
    exec(compile(module, str(SERVER_PATH), "exec"), namespace)
    return namespace[name]


class ServerSafetyTests(unittest.TestCase):
    def test_tokenizer_cleanup_removes_known_problem_input(self):
        sanitize = load_server_helper("sanitize_text_for_tokenizer")
        value = sanitize("\u2014\n‘A_[TL note]*\u4e2dB\u2019\n*** drop this")
        self.assertEqual(value, "...\n'A B'")

    def test_queued_chapters_clean_text_before_sentence_chunking(self):
        tree = ast.parse(SERVER_PATH.read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_synthesize_book_chapter")
        statements = [node for node in function.body if isinstance(node, ast.Assign)]
        safe_text = next(node for node in statements if any(isinstance(target, ast.Name) and target.id == "safe_text" for target in node.targets))
        chunks = next(node for node in statements if any(isinstance(target, ast.Name) and target.id == "chunks" for target in node.targets))
        self.assertIsInstance(safe_text.value, ast.Call)
        self.assertEqual(getattr(safe_text.value.func, "id", None), "sanitize_text_for_tokenizer")
        self.assertIn("safe_text", ast.unparse(chunks.value))

    def test_unique_output_write_preserves_existing_chapter_download(self):
        write_unique = load_server_helper("_write_unique_output_file")
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            existing = output_dir / "Book_ch1-1_Audiobook.mp3"
            existing.write_bytes(b"original")
            filename, written = write_unique(output_dir, existing.name, b"replacement")
            self.assertEqual(filename, "Book_ch1-1_Audiobook_2.mp3")
            self.assertEqual(existing.read_bytes(), b"original")
            self.assertEqual(written.read_bytes(), b"replacement")
