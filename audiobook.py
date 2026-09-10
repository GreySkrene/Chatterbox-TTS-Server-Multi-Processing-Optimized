"""Persistent, resumable book import and audiobook generation support."""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import struct
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable, Optional
from xml.etree import ElementTree as ET


MAX_UPLOAD_BYTES = 250 * 1024 * 1024
MAX_ARCHIVE_FILES = 10_000
MAX_ARCHIVE_UNCOMPRESSED = 500 * 1024 * 1024
CHAPTER_RE = re.compile(r"(?im)^\s*(?:(?:volume|book)\s+\w+\s*[-:]?\s*)?(?:chapter|ch\.?)\s*(\d+)\b[^\n]*")
# Some EPUB producers use a chapter file per spine item, but render its heading
# as just ``1 A New Beginning`` rather than ``Chapter 1: A New Beginning``.
# This intentionally only recognizes the first rendered line and is paired with
# a chapter-like source filename below, so prose cannot become a chapter boundary.
NUMERIC_TITLE_HEADING_RE = re.compile(r"\A\s*(\d{1,6})\s+([^\n]+?\S)\s*(?:\n|\Z)")
EPUB_CHAPTER_PATH_RE = re.compile(r"(?:^|[_\-.])(?:chapter|chap|ch)[_\-.]*\d+\b", re.IGNORECASE)
# Only unnumbered documents at the *end* of an EPUB's story spine are eligible
# for synthetic chapter labels.  This deliberately uses narrow, reader-facing
# headings rather than source paths: a great many books have unnumbered cover,
# navigation, volume, and front-matter documents in the same spine.
EPUB_TAIL_HEADING_RE = re.compile(
    r"(?i)^(?:"
    r"(?:other\s+)?(?:tales?|stories)(?:\s+\d+)?(?:\s*[:\-]\s*.+)?"
    r"|(?:bonus|extra|special)\s+(?:tales?|stories|chapters?)(?:\s+\d+)?(?:\s*[:\-]\s*.+)?"
    r"|side\s+stor(?:y|ies)(?:\s+\d+)?(?:\s*[:\-]\s*.+)?"
    r"|dear\s+(?:(?:fellow|my)\s+)?(?:daoists?|readers?|fans?)\b.*"
    r"|letter\s+to\s+(?:(?:the|my)\s+)?(?:daoists?|readers?|fans?)\b.*"
    r")$"
)
NOTE_BLOCK_RE = re.compile(
    r"(?ims)^\s*(?:translator(?:'s)?\s+note|translation\s+note|footnotes?|t/?l\s+note)s?\s*[:\-].*?(?=^\s*(?:chapter|ch\.?)\s*\d+\b|\Z)"
)
EXCLUDED_HEADING_RE = re.compile(
    r"(?i)^(?:cover|contents?|table of contents|navigation|copyright|title page|preface|prologue|epilogue|afterword|about the author|volume\s+\w+|letter\s+from)\b"
)
END_MATTER_RE = re.compile(r"(?im)^\s*(?:letter\s+from|about the author|endnotes?|appendix|afterword)\b.*\Z")
DIVIDER_LINE_RE = re.compile(r"(?im)^\s*(?:cover|contents?|navigation|volume\s+[\w\d]+)\s*$")


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # A stable ``.tmp`` name lets concurrent writers delete each other's
    # staging file between write and replace.  Keep the temporary alongside
    # the manifest (so replace remains atomic) but make it writer-unique.
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        # ``os.replace`` removes the source.  This only covers a failed write
        # or replace and never touches another writer's uniquely named file.
        temp.unlink(missing_ok=True)


def natural_key(value: str) -> list[Any]:
    return [int(x) if x.isdigit() else x.casefold() for x in re.split(r"(\d+)", value)]


def capped_chapter_end(numbers: Iterable[int], start: int, limit: int = 600) -> Optional[int]:
    """Return the detected chapter at most ``limit`` entries from ``start``.

    This deliberately counts parsed chapter entries rather than the difference
    between their displayed numbers, which may contain legitimate gaps.
    """
    if limit < 1:
        raise ValueError("chapter limit must be positive.")
    detected = list(numbers)
    start_index = next((index for index, number in enumerate(detected) if number >= start), None)
    if start_index is None:
        return None
    return detected[min(len(detected) - 1, start_index + limit - 1)]


def safe_book_stem(title: str, max_length: int = 120) -> str:
    words = re.findall(r"[A-Za-z0-9]+", " ".join(str(title or "Audiobook").split()))
    stem = "".join(words) or "Audiobook"
    return stem[:max_length].rstrip(". ") or "Audiobook"


def chapter_filename(title: str, start: int, end: int, output_format: str = "mp3") -> str:
    return f"{safe_book_stem(title)}_ch{start}-{end}_Audiobook.{output_format}"


def reserve_filename(output_dir: Path, desired: str, reserved: Iterable[str] = ()) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    used = set(reserved)
    candidate = desired
    stem, suffix = Path(desired).stem, Path(desired).suffix
    index = 2
    while candidate in used or (output_dir / candidate).exists():
        candidate = f"{stem}_{index}{suffix}"
        index += 1
    return candidate


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag in {"script", "style", "nav", "title"}:
            self.skip += 1
        elif not self.skip and tag in {"p", "div", "br", "h1", "h2", "h3", "h4", "li"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "nav", "title"} and self.skip:
            self.skip -= 1
        elif not self.skip and tag in {"p", "div", "h1", "h2", "h3", "h4", "li"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)

    def text(self) -> str:
        value = html.unescape("".join(self.parts)).replace("\r", "")
        value = re.sub(r"[ \t]+", " ", value)
        return re.sub(r"\n\s*\n+", "\n\n", value).strip()


def html_to_text(data: bytes) -> str:
    parser = _TextExtractor()
    parser.feed(data.decode("utf-8", errors="replace"))
    return parser.text()


@dataclass
class Chapter:
    number: int
    heading: str
    text: str

    def as_dict(self) -> dict[str, Any]:
        return {"number": self.number, "heading": self.heading, "text": self.text}


@dataclass(frozen=True)
class EpubPart:
    """A rendered spine document, with optional safe numeric-heading fallback."""

    text: str
    source_name: str = ""
    inferred_number: Optional[int] = None
    inferred_heading: str = ""
    tail_heading: str = ""


def chapters_from_text(text: str, remove_notes: bool = False) -> tuple[list[Chapter], list[str], list[str]]:
    text = text.replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n")
    matches = list(CHAPTER_RE.finditer(text))
    errors: list[str] = []
    warnings: list[str] = []
    if not matches:
        return [], ["No numbered chapter headings were detected."], warnings

    # A TOC is usually a dense heading-only run before the first chapter body. Prefer
    # the last occurrence of the first chapter number when it has meaningful content.
    by_number: dict[int, list[int]] = {}
    for idx, match in enumerate(matches):
        by_number.setdefault(int(match.group(1)), []).append(idx)
    first_number = int(matches[0].group(1))
    # When a TOC precedes the story, use the first repeated occurrence as the
    # beginning of content. Do not use the last occurrence: prose later in the
    # book can itself begin a line with "Chapter 1".
    start_idx = by_number[first_number][1] if len(by_number[first_number]) > 1 else 0
    matches = matches[start_idx:]

    # Lightnovel Crawler TXT exports commonly emit two adjacent headings for
    # every real chapter: a navigation-style ``Chapter N - ...`` line followed
    # by the displayed ``Chapter N: ...`` heading. They contain no prose
    # between them, so keep only the latter rather than reporting duplicates.
    collapsed = []
    for index, match in enumerate(matches):
        if index + 1 < len(matches) and int(match.group(1)) == int(matches[index + 1].group(1)):
            between = text[match.end():matches[index + 1].start()]
            if not re.sub(r"(?im)^\s*volume\s+\w+\s*$", "", between).strip():
                continue
        collapsed.append(match)
    matches = collapsed

    chapters: list[Chapter] = []
    seen: set[int] = set()
    for idx, match in enumerate(matches):
        number = int(match.group(1))
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        heading = " ".join(match.group(0).strip().split())
        body = text[match.end():end].strip()
        if EXCLUDED_HEADING_RE.match(heading):
            continue
        if number in seen:
            errors.append(f"Duplicate chapter {number}.")
            continue
        seen.add(number)
        if remove_notes:
            body = NOTE_BLOCK_RE.sub("", body).strip()
        body = END_MATTER_RE.sub("", body)
        body = DIVIDER_LINE_RE.sub("", body).strip()
        if len(body) < 20:
            warnings.append(f"Chapter {number} has very little body text.")
        chapters.append(Chapter(number, heading, f"{heading}\n\n{body}".strip()))

    numbers = [c.number for c in chapters]
    if numbers != sorted(numbers):
        errors.append("Chapters are out of order.")
    if numbers:
        missing = sorted(set(range(numbers[0], numbers[-1] + 1)) - set(numbers))
        if missing:
            warnings.append("Missing chapter numbers: " + ", ".join(map(str, missing[:50])))
    return chapters, sorted(set(errors)), sorted(set(warnings))


def _numeric_epub_heading(rendered: str, source_name: str) -> tuple[int, str] | None:
    """Return an inferred heading only for a chapter-named EPUB document."""
    if not EPUB_CHAPTER_PATH_RE.search(Path(source_name).stem):
        return None
    match = NUMERIC_TITLE_HEADING_RE.match(rendered)
    if not match:
        return None
    number = int(match.group(1))
    title = " ".join(match.group(2).split())
    # A numeric-only line is too weak a signal. Requiring a title also keeps
    # chapter-count labels and decorative page numbers out of the import.
    if not title or title.casefold().startswith(("chapter ", "volume ")):
        return None
    return number, f"Chapter {number}: {title}"


def _epub_heading_block(rendered: str) -> tuple[str, str]:
    """Return the displayed heading block and remaining document body."""
    # This avoids treating deliberate line breaks inside an H1 as body text.
    pieces = re.split(r"\n\s*\n", rendered, maxsplit=1)
    block = pieces[0]
    body = pieces[1] if len(pieces) == 2 else ""
    return " ".join(block.split()), body.strip()


def _epub_tail_content(rendered: str) -> tuple[str, str] | None:
    """Return a conservative reader-facing tail heading and its body.

    The caller only accepts these candidates after a numbered story chapter and
    only if no later numbered chapter appears in the spine.  Keeping the
    heading exactly as rendered lets the synthesizer speak it once while its
    synthetic number is used solely for selection and filenames. EPUBs may put
    an internal ``#1614`` counter before the heading and repeat the heading in
    the first paragraph, so scan blocks and discard adjacent duplicates.
    """
    blocks = [" ".join(block.split()) for block in re.split(r"\n\s*\n", rendered) if block.strip()]
    for index, heading in enumerate(blocks):
        if not EPUB_TAIL_HEADING_RE.match(heading):
            continue
        body_index = index + 1
        heading_key = re.sub(r"\W+", "", heading.casefold())
        while body_index < len(blocks) and re.sub(r"\W+", "", blocks[body_index].casefold()) == heading_key:
            body_index += 1
        return heading, "\n\n".join(blocks[body_index:]).strip()
    return None


def _epub_tail_heading(rendered: str) -> str | None:
    content = _epub_tail_content(rendered)
    return content[0] if content else None


def _epub_parts(data: bytes) -> tuple[str, list[EpubPart]]:
    import io
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ARCHIVE_FILES or sum(i.file_size for i in infos) > MAX_ARCHIVE_UNCOMPRESSED:
            raise ValueError("EPUB archive is too large.")
        for info in infos:
            normalized = Path(info.filename.replace("\\", "/"))
            if normalized.is_absolute() or ".." in normalized.parts:
                raise ValueError("EPUB contains an unsafe path.")
        container = ET.fromstring(archive.read("META-INF/container.xml"))
        rootfile = next(e for e in container.iter() if e.tag.endswith("rootfile"))
        opf_name = rootfile.attrib["full-path"]
        opf = ET.fromstring(archive.read(opf_name))
        title = next((e.text or "" for e in opf.iter() if e.tag.endswith("title") and e.text), "Untitled Book")
        manifest = {e.attrib.get("id"): e.attrib.get("href") for e in opf.iter() if e.tag.endswith("item")}
        spine = [e.attrib.get("idref") for e in opf.iter() if e.tag.endswith("itemref") and e.attrib.get("linear", "yes") != "no"]
        base = Path(opf_name).parent
        parts: list[EpubPart] = []
        # Candidates are held until the entire spine has been examined.  A
        # later numbered chapter means they were interstitial material, not the
        # book's tail, so they are discarded.
        tail_candidates: list[EpubPart] = []
        saw_numbered_story = False
        for item_id in spine:
            href = manifest.get(item_id)
            if not href:
                continue
            name = (base / href.split("#", 1)[0]).as_posix()
            if name in archive.namelist():
                rendered = html_to_text(archive.read(name))
                # Keep numbered story documents only. This prevents cover/front
                # pages, volume dividers, navigation, unnumbered bonus tales,
                # and translator end letters from becoming part of the adjacent
                # numbered chapter merely because they share the EPUB spine.
                if CHAPTER_RE.search(rendered):
                    parts.append(EpubPart(rendered, name))
                    saw_numbered_story = True
                    tail_candidates.clear()
                    continue
                numeric_heading = _numeric_epub_heading(rendered, name)
                if numeric_heading:
                    number, heading = numeric_heading
                    parts.append(EpubPart(rendered, name, number, heading))
                    saw_numbered_story = True
                    tail_candidates.clear()
                    continue
                tail_heading = _epub_tail_heading(rendered)
                if saw_numbered_story and tail_heading:
                    tail_candidates.append(EpubPart(rendered, name, tail_heading=tail_heading))
        # These are necessarily after the final numbered story document, in
        # spine order.  Front matter and arbitrary unnumbered end matter never
        # enter ``tail_candidates``.
        parts.extend(tail_candidates)
        return " ".join(title.split()), parts


def chapters_from_epub_parts(parts: list[str | EpubPart], remove_notes: bool = False) -> tuple[list[Chapter], list[str], list[str]]:
    """Extract one displayed chapter from each numbered EPUB spine document."""
    chapters: list[Chapter] = []
    errors: list[str] = []
    warnings: list[str] = []
    seen: set[int] = set()
    last_real_number: Optional[int] = None
    next_synthetic_number: Optional[int] = None
    for item in parts:
        part = item if isinstance(item, EpubPart) else EpubPart(item)
        rendered = part.text
        matches = list(CHAPTER_RE.finditer(rendered))
        if matches:
            primary = matches[0]
            # Many EPUBs render both a generic H1 ("Chapter N") and the actual
            # titled paragraph immediately after it. Prefer the latter once.
            if len(matches) > 1 and int(matches[1].group(1)) == int(primary.group(1)):
                between = rendered[primary.end():matches[1].start()]
                if not between.strip():
                    primary = matches[1]
            number = int(primary.group(1))
            heading = " ".join(primary.group(0).strip().split())
            body = rendered[primary.end():].strip()
        elif part.inferred_number is not None:
            numeric_match = NUMERIC_TITLE_HEADING_RE.match(rendered)
            if not numeric_match:
                continue
            number = part.inferred_number
            heading = part.inferred_heading
            body = rendered[numeric_match.end():].strip()
            location = Path(part.source_name).name or "this EPUB document"
            warnings.append(f"Chapter {number} inferred from numeric EPUB heading in {location}.")
        elif part.tail_heading and last_real_number is not None:
            # Synthetic numbering exists only to make an intentional bonus
            # document selectable and nameable.  The spoken heading remains
            # the original EPUB text, never "Chapter N".
            if next_synthetic_number is None:
                next_synthetic_number = last_real_number + 1
            number = next_synthetic_number
            next_synthetic_number += 1
            heading = part.tail_heading
            content = _epub_tail_content(rendered)
            if not content:
                continue
            _, body = content
            location = Path(part.source_name).name or "this EPUB document"
            warnings.append(f"Synthetic chapter {number}: {heading} ({location}).")
        else:
            continue
        if number in seen:
            errors.append(f"Duplicate chapter {number}.")
            continue
        seen.add(number)
        if remove_notes:
            body = NOTE_BLOCK_RE.sub("", body).strip()
        body = END_MATTER_RE.sub("", body)
        body = DIVIDER_LINE_RE.sub("", body).strip()
        if len(body) < 20:
            warnings.append(f"Chapter {number} has very little body text.")
        chapters.append(Chapter(number, heading, f"{heading}\n\n{body}".strip()))
        if not part.tail_heading:
            last_real_number = number
            next_synthetic_number = None
    numbers = [chapter.number for chapter in chapters]
    if numbers != sorted(numbers):
        errors.append("Chapters are out of order.")
    if numbers:
        missing = sorted(set(range(numbers[0], numbers[-1] + 1)) - set(numbers))
        if missing:
            warnings.append("Missing chapter numbers: " + ", ".join(map(str, missing[:50])))
    return chapters, sorted(set(errors)), sorted(set(warnings))


def parse_uploads(files: list[tuple[str, bytes]], remove_notes: bool = False) -> tuple[str, list[Chapter], list[str], list[str]]:
    if not files:
        raise ValueError("No files were uploaded.")
    if sum(len(data) for _, data in files) > MAX_UPLOAD_BYTES:
        raise ValueError("Upload exceeds the 250 MB limit.")
    epubs = [(n, d) for n, d in files if Path(n).suffix.casefold() == ".epub"]
    unsupported = [n for n, _ in files if Path(n).suffix.casefold() not in {".epub", ".txt"}]
    if unsupported:
        raise ValueError("Unsupported file type: " + ", ".join(unsupported[:5]))
    if epubs and len(files) != 1:
        raise ValueError("Upload one EPUB at a time, or a bundle of TXT files.")
    if epubs:
        title, parts = _epub_parts(epubs[0][1])
        chapters, errors, warnings = chapters_from_epub_parts(parts, remove_notes)
    else:
        ordered = sorted(files, key=lambda item: natural_key(item[0]))
        title = Path(ordered[0][0]).stem if len(ordered) == 1 else Path(ordered[0][0]).parent.name
        if not title or title == ".":
            title = "Untitled Book"
        decoded = []
        for _, data in ordered:
            try:
                decoded.append(data.decode("utf-8-sig"))
            except UnicodeDecodeError:
                decoded.append(data.decode("cp1252", errors="replace"))
        text = "\n\n".join(decoded)
        if len(ordered) == 1:
            first_line = next((" ".join(line.split()) for line in decoded[0].splitlines() if line.strip()), "")
            if first_line and len(first_line) <= 300 and not CHAPTER_RE.match(first_line):
                title = first_line
    if not epubs:
        chapters, errors, warnings = chapters_from_text(text, remove_notes)
    return title, chapters, errors, warnings


def make_sections(chapters: list[Chapter], size: int) -> list[dict[str, Any]]:
    if size < 1:
        raise ValueError("chapters_per_section must be positive.")
    sections = []
    for offset in range(0, len(chapters), size):
        group = chapters[offset:offset + size]
        sections.append({
            "id": str(len(sections) + 1), "chapter_start": group[0].number,
            "chapter_end": group[-1].number, "chapter_count": len(group),
            "character_count": sum(len(c.text) for c in group),
            "chapters": [c.as_dict() for c in group], "selected": True,
        })
    return sections


class BookStore:
    def __init__(self, root: Path, output_dir: Path):
        self.root, self.output_dir = root, output_dir
        self.imports = root / "imports"
        self.jobs = root / "jobs"
        self.imports.mkdir(parents=True, exist_ok=True)
        self.jobs.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def create_import(self, title: str, chapters: list[Chapter], errors: list[str], warnings: list[str], section_size: int, sources: list[tuple[str, bytes]]) -> dict[str, Any]:
        with self.lock:
            import_id = uuid.uuid4().hex
            directory = self.imports / import_id
            (directory / "sources").mkdir(parents=True)
            for index, (name, data) in enumerate(sources):
                (directory / "sources" / f"{index:04d}_{Path(name).name}").write_bytes(data)
            manifest = {"id": import_id, "title": title, "chapter_count": len(chapters), "sections": make_sections(chapters, section_size), "errors": errors, "warnings": warnings, "created_at": time.time()}
            _atomic_json(directory / "manifest.json", manifest)
            return manifest

    def read_import(self, import_id: str) -> dict[str, Any]:
        with self.lock:
            path = self.imports / import_id / "manifest.json"
            if not path.is_file():
                raise KeyError(import_id)
            return json.loads(path.read_text(encoding="utf-8"))

    def list_jobs(self) -> list[dict[str, Any]]:
        with self.lock:
            jobs = [self._read_job_unlocked(p.parent.name) for p in self.jobs.glob("*/manifest.json")]
            return sorted(jobs, key=lambda x: x.get("created_at", 0), reverse=True)

    def read_job(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            return self._read_job_unlocked(job_id)

    def _read_job_unlocked(self, job_id: str) -> dict[str, Any]:
        path = self.jobs / job_id / "manifest.json"
        if not path.is_file():
            raise KeyError(job_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def write_job(self, job: dict[str, Any]) -> None:
        with self.lock:
            self._write_job_unlocked(job)

    def _write_job_unlocked(self, job: dict[str, Any]) -> None:
        job["updated_at"] = time.time()
        _atomic_json(self.jobs / job["id"] / "manifest.json", job)

    def update_job(self, job_id: str, mutation: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        """Apply a manifest mutation without exposing a read-modify-write gap."""
        with self.lock:
            job = self._read_job_unlocked(job_id)
            mutation(job)
            self._write_job_unlocked(job)
            return job

    def create_job(self, imported: dict[str, Any], title: str, selected: list[str], settings: dict[str, Any], selected_chapters: Optional[list[int]] = None, section_size: int = 50, merge_final_section: bool = False, requested_chapter_start: Optional[int] = None, requested_chapter_end: Optional[int] = None) -> dict[str, Any]:
        # Filename reservation and manifest creation are one critical section;
        # otherwise simultaneous requests can reserve the same output name.
        with self.lock:
            return self._create_job(imported, title, selected, settings, selected_chapters, section_size, merge_final_section, requested_chapter_start, requested_chapter_end)

    def _create_job(self, imported: dict[str, Any], title: str, selected: list[str], settings: dict[str, Any], selected_chapters: Optional[list[int]] = None, section_size: int = 50, merge_final_section: bool = False, requested_chapter_start: Optional[int] = None, requested_chapter_end: Optional[int] = None) -> dict[str, Any]:
        if imported.get("errors"):
            raise ValueError("Import has unresolved parsing errors.")
        if selected_chapters is not None:
            if section_size < 1:
                raise ValueError("chapters_per_section must be positive.")
            wanted = set(selected_chapters)
            all_chapters = [chapter for section in imported["sections"] for chapter in section["chapters"]]
            unique = {chapter["number"]: chapter for chapter in all_chapters}
            missing = sorted(wanted - set(unique))
            if missing:
                raise ValueError("Unknown selected chapter numbers: " + ", ".join(map(str, missing[:50])))
            requested_chapter_start = requested_chapter_start if requested_chapter_start is not None else min(wanted, default=None)
            requested_chapter_end = requested_chapter_end if requested_chapter_end is not None else max(wanted, default=None)
            if requested_chapter_start is None or requested_chapter_end is None or requested_chapter_start > requested_chapter_end:
                raise ValueError("Enter a valid requested chapter range.")
            outside = sorted(number for number in wanted if number < requested_chapter_start or number > requested_chapter_end)
            if outside:
                raise ValueError("Selected chapters fall outside the requested range: " + ", ".join(map(str, outside[:50])))

            # Stable numeric buckets prevent one bad/missing displayed label
            # from shifting every subsequent output.  A gap also creates a
            # separate output on either side of it, so a recovered chapter can
            # later be generated by itself without editing a larger audiobook.
            available_in_range = [chapter for chapter in all_chapters if requested_chapter_start <= chapter["number"] <= requested_chapter_end]
            if not available_in_range:
                raise ValueError("No detected chapters fall within the requested range.")
            effective_end = max(chapter["number"] for chapter in available_in_range)
            available_numbers = {chapter["number"] for chapter in available_in_range}
            chosen = []
            for bucket_start in range(requested_chapter_start, effective_end + 1, section_size):
                bucket_end = min(bucket_start + section_size - 1, effective_end)
                group = [chapter for chapter in available_in_range if bucket_start <= chapter["number"] <= bucket_end and chapter["number"] in wanted]

                # Split an otherwise fixed bucket into runs of adjacent
                # selected chapters.  Do not let an unavailable source label
                # or an unchecked chapter bridge two audio files.
                runs: list[list[dict[str, Any]]] = []
                for chapter in group:
                    if not runs or chapter["number"] != runs[-1][-1]["number"] + 1:
                        runs.append([chapter])
                    else:
                        runs[-1].append(chapter)

                for run_index, run in enumerate(runs):
                    run_start, run_end = run[0]["number"], run[-1]["number"]
                    # Keep gap metadata with the output immediately before a
                    # split.  It documents why the next output begins later,
                    # without making an audio file claim it contains labels it
                    # cannot contain.  Leading gaps belong to the first run.
                    next_start = runs[run_index + 1][0]["number"] if run_index + 1 < len(runs) else bucket_end + 1
                    relevant_start = bucket_start if run_index == 0 else run_end + 1
                    relevant_end = (next_start - 1) if run_index + 1 < len(runs) else bucket_end
                    gap_numbers = range(relevant_start, relevant_end + 1)
                    run_missing = [number for number in gap_numbers if number not in available_numbers]
                    run_omitted = [number for number in range(relevant_start, relevant_end + 1) if number in available_numbers and number not in wanted]
                    warnings = []
                    if run_missing:
                        warnings.append("Missing displayed chapter numbers: " + ", ".join(map(str, run_missing)))
                    if run_omitted:
                        warnings.append("Unchecked chapter numbers: " + ", ".join(map(str, run_omitted)))
                    chosen.append({
                        "id": str(len(chosen) + 1), "chapter_start": run_start,
                        "chapter_end": run_end, "chapter_count": len(run),
                        "character_count": sum(len(chapter["text"]) for chapter in run),
                        "chapters": run, "selected": True,
                        "missing_chapters": run_missing, "omitted_chapters": run_omitted,
                        "warnings": warnings, "bucket_start": bucket_start, "bucket_end": bucket_end,
                    })
            if merge_final_section and len(chosen) > 1:
                tail, previous = chosen[-1], chosen[-2]
                tail_span = tail["bucket_end"] - tail["bucket_start"] + 1
                # A merge is only safe for a complete, contiguous final
                # nominal bucket.  Never merge around a missing/unchecked
                # chapter or across an earlier split within that bucket.
                if (tail_span < section_size
                        and tail["chapter_start"] == tail["bucket_start"]
                        and tail["chapter_end"] == tail["bucket_end"]
                        and not tail["missing_chapters"] and not tail["omitted_chapters"]
                        and previous["chapter_end"] + 1 == tail["chapter_start"]
                        and previous.get("bucket_end") + 1 == tail["bucket_start"]):
                    previous["chapter_end"] = tail["chapter_end"]
                    previous["chapter_count"] += tail["chapter_count"]
                    previous["character_count"] += tail["character_count"]
                    previous["chapters"].extend(tail["chapters"])
                    previous["missing_chapters"].extend(tail["missing_chapters"])
                    previous["omitted_chapters"].extend(tail["omitted_chapters"])
                    previous["warnings"].extend(tail["warnings"])
                    previous["bucket_end"] = tail["bucket_end"]
                    chosen.pop()
        else:
            chosen = [s for s in imported["sections"] if s["id"] in selected]
        if not chosen:
            raise ValueError("Select at least one chapter or section.")
        # Custom non-contiguous selections may create several independent runs;
        # ensure every persisted section has a unique queue identifier.
        chosen = [dict(section, id=str(index)) for index, section in enumerate(chosen, 1)]
        job_id = uuid.uuid4().hex
        reserved = {s.get("output_name") for j in self.list_jobs() for s in j.get("sections", [])}
        sections = []
        for section in chosen:
            copy = dict(section)
            copy.update({"state": "pending", "completed_chapters": 0, "error": None})
            desired = chapter_filename(title, copy["chapter_start"], copy["chapter_end"], settings.get("output_format", "mp3"))
            copy["output_name"] = reserve_filename(self.output_dir, desired, reserved)
            reserved.add(copy["output_name"])
            sections.append(copy)
        job = {"id": job_id, "import_id": imported["id"], "source_title": imported.get("title"), "book_title": " ".join(title.split()), "state": "pending", "chapters_per_section": section_size, "merge_final_section": merge_final_section, "requested_chapter_start": requested_chapter_start, "requested_chapter_end": requested_chapter_end, "settings": settings, "sections": sections, "created_at": time.time(), "updated_at": time.time()}
        (self.jobs / job_id).mkdir(parents=True)
        self.write_job(job)
        return job

    @staticmethod
    def _sections_from_chapter_dicts(chapters: list[dict[str, Any]], size: int, merge_final: bool = False) -> list[dict[str, Any]]:
        groups = [chapters[offset:offset + size] for offset in range(0, len(chapters), size)]
        if merge_final and len(groups) > 1 and len(groups[-1]) < size:
            groups[-2].extend(groups.pop())
        sections = []
        for group in groups:
            sections.append({
                "id": str(len(sections) + 1), "chapter_start": group[0]["number"],
                "chapter_end": group[-1]["number"], "chapter_count": len(group),
                "character_count": sum(len(c["text"]) for c in group),
                "chapters": group, "selected": True,
            })
        return sections


class JobRunner:
    """Sequential worker. The synthesizer appends float32 mono samples per chapter."""
    def __init__(self, store: BookStore, synthesizer: Callable[[str, dict[str, Any], Path], tuple[int, int]], generation_lock: Optional[threading.Lock] = None):
        self.store, self.synthesizer = store, synthesizer
        self.generation_lock = generation_lock or threading.Lock()
        self.controls: dict[str, threading.Event] = {}
        self.threads: dict[str, threading.Thread] = {}
        self._recover()

    def _recover(self) -> None:
        for job in self.store.list_jobs():
            if job["state"] in {"running", "pending"}:
                def recover(current: dict[str, Any]) -> None:
                    for section in current["sections"]:
                        if self._has_finalized_output(current["id"], section):
                            # An MP3 is atomically moved into place only after
                            # encoding/fsync.  If its raw source is gone, a
                            # crash occurred after successful finalization.
                            section.update(state="completed", error=None)
                        elif section["state"] == "running":
                            section["state"] = "interrupted"
                    current["state"] = "completed" if all(section["state"] == "completed" for section in current["sections"]) else "interrupted"

                self.store.update_job(job["id"], recover)

    def _has_finalized_output(self, job_id: str, section: dict[str, Any]) -> bool:
        """Whether a crashed finalization can safely be treated as complete."""
        output_name = section.get("output_name")
        chapters = section.get("chapters", [])
        if not isinstance(output_name, str) or not output_name or not isinstance(chapters, list):
            return False
        try:
            destination = (self.store.output_dir / output_name).resolve()
            destination.relative_to(self.store.output_dir.resolve())
        except (OSError, ValueError):
            return False
        raw = self.store.jobs / job_id / f"section-{section.get('id')}.f32"
        try:
            completed_chapters = int(section.get("completed_chapters", 0))
        except (TypeError, ValueError):
            return False
        return (
            section.get("state") != "completed"
            and completed_chapters >= len(chapters)
            and destination.is_file()
            and destination.stat().st_size > 0
            and not raw.exists()
        )

    def start(self, job_id: str) -> None:
        if job_id in self.threads and self.threads[job_id].is_alive(): return
        event = self.controls.setdefault(job_id, threading.Event())
        event.clear()
        thread = threading.Thread(target=self._run, args=(job_id,), daemon=True, name=f"book-job-{job_id[:8]}")
        self.threads[job_id] = thread
        thread.start()

    def control(self, job_id: str, action: str) -> dict[str, Any]:
        if action == "pause":
            self.controls.setdefault(job_id, threading.Event()).set()
            return self.store.update_job(job_id, lambda job: job.update(state="paused"))
        elif action == "cancel":
            self.controls.setdefault(job_id, threading.Event()).set()
            return self.store.update_job(job_id, lambda job: job.update(state="cancelled"))
        elif action in {"resume", "retry-failed"}:
            def resume(job: dict[str, Any]) -> None:
                if action == "retry-failed":
                    for section in job["sections"]:
                        if section["state"] == "failed":
                            section.update(state="pending", error=None)
                job["state"] = "pending"
            self.store.update_job(job_id, resume)
            self.start(job_id)
            return self.store.read_job(job_id)
        else: raise ValueError(action)

    def _run(self, job_id: str) -> None:
        with self.generation_lock:
            job = self.store.update_job(job_id, lambda current: current.update(state="running"))
            stop = self.controls[job_id]
            for section in job["sections"]:
                job = self.store.read_job(job_id)
                if stop.is_set(): return
                section = next(s for s in job["sections"] if s["id"] == section["id"])
                if section["state"] in {"completed", "failed"}: continue
                try:
                    section_id = section["id"]
                    job = self.store.update_job(
                        job_id,
                        lambda current: next(s for s in current["sections"] if s["id"] == section_id).update(state="running"),
                    )
                    section = next(s for s in job["sections"] if s["id"] == section_id)
                    raw = self.store.jobs / job_id / f"section-{section['id']}.f32"
                    # Each chapter is committed only after fsync; truncate any uncommitted tail.
                    committed = int(section.get("pcm_bytes", 0))
                    if raw.exists():
                        with raw.open("r+b") as fh: fh.truncate(committed)
                    for chapter in section["chapters"][section["completed_chapters"]:]:
                        if stop.is_set(): return
                        sample_rate, written = self.synthesizer(chapter["text"], job["settings"], raw)
                        def commit_chapter(current: dict[str, Any]) -> None:
                            latest_section = next(s for s in current["sections"] if s["id"] == section_id)
                            latest_section["sample_rate"] = sample_rate
                            latest_section["pcm_bytes"] = int(latest_section.get("pcm_bytes", 0)) + written
                            latest_section["completed_chapters"] += 1
                        latest = self.store.update_job(job_id, commit_chapter)
                        latest_section = next(s for s in latest["sections"] if s["id"] == section_id)
                        job, section = latest, latest_section
                        if stop.is_set(): return
                    self._encode_mp3(raw, self.store.output_dir / section["output_name"], section["sample_rate"])
                    # Commit completion before deleting raw PCM.  Recovery also
                    # recognizes the older inverse ordering used by prior runs.
                    self.store.update_job(
                        job_id,
                        lambda current: next(s for s in current["sections"] if s["id"] == section_id).update(state="completed", error=None),
                    )
                    raw.unlink(missing_ok=True)
                    # A pause/cancel request can arrive while MP3 encoding is in
                    # progress.  Keep that control state after safely committing
                    # the finished section instead of continuing into the next.
                    if stop.is_set():
                        return
                except Exception as exc:
                    self.store.update_job(
                        job_id,
                        lambda current: next(s for s in current["sections"] if s["id"] == section["id"]).update(state="failed", error=str(exc)),
                    )
            def finish_job(current: dict[str, Any]) -> None:
                # Do not race a control request that landed after the final
                # section loop check.
                if current.get("state") in {"paused", "cancelled"}:
                    return
                current["state"] = "completed" if all(s["state"] == "completed" for s in current["sections"]) else "failed"

            self.store.update_job(job_id, finish_job)

    @staticmethod
    def _encode_mp3(raw: Path, destination: Path, sample_rate: int) -> None:
        try:
            import lameenc
        except ImportError as exc:
            raise RuntimeError("The packaged lameenc MP3 encoder is not installed.") from exc
        encoder = lameenc.Encoder(); encoder.set_bit_rate(128); encoder.set_in_sample_rate(sample_rate); encoder.set_channels(1); encoder.set_quality(2)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.part")
        try:
            with raw.open("rb") as source, temp.open("wb") as target:
                while True:
                    floats = source.read(256 * 1024)
                    if not floats: break
                    count = len(floats) // 4
                    values = struct.unpack("<" + "f" * count, floats[:count * 4])
                    pcm16 = struct.pack("<" + "h" * count, *(max(-32768, min(32767, int(v * 32767))) for v in values))
                    target.write(encoder.encode(pcm16))
                target.write(encoder.flush()); target.flush(); os.fsync(target.fileno())
            os.replace(temp, destination)
        finally:
            temp.unlink(missing_ok=True)
