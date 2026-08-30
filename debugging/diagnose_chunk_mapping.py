"""Inspect the production text chunker from the command line."""

import argparse
import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from config import config_manager  # noqa: E402
from utils import chunk_text_by_sentences  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect a specific chunk produced by the server's text chunker."
    )
    parser.add_argument("input", type=Path, help="UTF-8 text file to chunk")
    parser.add_argument(
        "--chunk-index", type=int, default=1, help="1-based chunk index to inspect"
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=None,
        help="Maximum chunk length; defaults to the current UI setting",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Directory for the extracted chunk",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.chunk_index < 1:
        raise SystemExit("--chunk-index must be at least 1")

    chunk_size = args.chunk_size
    if chunk_size is None:
        chunk_size = config_manager.get_int("ui_state.last_chunk_size", 120)
    if chunk_size <= 0:
        raise SystemExit("--chunk-size must be greater than 0")

    text = args.input.read_text(encoding="utf-8")
    chunks = chunk_text_by_sentences(text, chunk_size)
    print(f"chunk_size={chunk_size}; produced {len(chunks)} chunks")

    index = args.chunk_index - 1
    if index >= len(chunks):
        raise SystemExit(
            f"Requested chunk {args.chunk_index} is outside 1..{len(chunks)}"
        )

    chunk = chunks[index]
    print(f"\n--- Chunk {args.chunk_index} (chars={len(chunk)}) ---\n")
    print(chunk[:2000])

    args.output_dir.mkdir(parents=True, exist_ok=True)
    output_path = args.output_dir / f"problem_chunk_{args.chunk_index}.txt"
    output_path.write_text(chunk, encoding="utf-8")
    print(f"\nSaved full chunk to: {output_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
