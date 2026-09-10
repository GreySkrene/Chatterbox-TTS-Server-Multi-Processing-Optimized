import io
import json
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import struct

import audiobook
from audiobook import BookStore, Chapter, JobRunner, _atomic_json, capped_chapter_end, chapter_filename, chapters_from_text, html_to_text, make_sections, parse_uploads, reserve_filename, safe_book_stem


class AudiobookTests(unittest.TestCase):
    def test_expected_filename(self):
        self.assertEqual(chapter_filename("I Shall Seal The Heavens", 501, 550), "IShallSealTheHeavens_ch501-550_Audiobook.mp3")
        self.assertEqual(safe_book_stem('  A: Book / With * Unsafe?  '), "ABookWithUnsafe")

    def test_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Book_ch1-2_Audiobook.mp3").touch()
            self.assertEqual(reserve_filename(root, "Book_ch1-2_Audiobook.mp3"), "Book_ch1-2_Audiobook_2.mp3")

    def test_txt_toc_is_skipped_and_heading_retained(self):
        text = "Contents\nChapter 1: Scholar Meng Hao\nChapter 2: The Test\n\nChapter 1: Scholar Meng Hao\n" + "Story text. " * 10 + "\nChapter 2: The Test\n" + "More story. " * 10
        chapters, errors, warnings = chapters_from_text(text)
        self.assertFalse(errors)
        self.assertEqual([c.number for c in chapters], [1, 2])
        self.assertTrue(chapters[0].text.startswith("Chapter 1: Scholar Meng Hao"))

    def test_lightnovel_crawler_toc_and_paired_headings_collapse(self):
        text = "Book Title\n\nChapter 1 - First\nChapter 2 - Second\n\nVolume 1\n\nChapter 1 - First\n\nChapter 1: Chapter 1 First\n" + "Story one. " * 10 + "\nChapter 2 - Second\n\nChapter 2: Chapter 2 Second\n" + "Story two. " * 10
        chapters, errors, _ = chapters_from_text(text)
        self.assertFalse(errors)
        self.assertEqual([chapter.number for chapter in chapters], [1, 2])
        self.assertEqual(chapters[0].text.count("Chapter 1:"), 1)

    def test_epub_title_and_repeated_rendered_heading_are_not_duplicated(self):
        rendered = html_to_text(b"<html><head><title>Chapter 501</title></head><body><h4>#502</h4><h1>Chapter 501</h1><p>Chapter 501: Choices</p><p>Story text repeated enough to be valid.</p></body></html>")
        self.assertNotIn("# title", rendered.casefold())
        chapters, errors, _ = chapters_from_text(rendered)
        self.assertFalse(errors)
        self.assertEqual([chapter.number for chapter in chapters], [501])
        self.assertTrue(chapters[0].text.startswith("Chapter 501: Choices"))

    def test_epub_numeric_title_fallback_is_limited_to_chapter_spine_documents(self):
        """Numeric-only style headings are allowed only in chapter-named files."""
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as archive:
            archive.writestr(
                "META-INF/container.xml",
                '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>',
            )
            archive.writestr(
                "EPUB/content.opf",
                '<package xmlns="http://www.idpf.org/2007/opf"><metadata><title>Fallback Book</title></metadata><manifest>'
                '<item id="front" href="front.xhtml"/><item id="one" href="text/chapter_001.xhtml"/>'
                '<item id="bonus" href="text/chapter_bonus.xhtml"/><item id="three" href="text/chapter_003.xhtml"/>'
                '</manifest><spine><itemref idref="front"/><itemref idref="one"/><itemref idref="bonus"/><itemref idref="three"/></spine></package>',
            )
            archive.writestr("EPUB/front.xhtml", "<h1>2 A Numbered Front Page</h1><p>Not a chapter.</p>")
            archive.writestr("EPUB/text/chapter_001.xhtml", "<h1>1 Anthony Reborn</h1><p>Story text long enough to count as a chapter body.</p>")
            archive.writestr("EPUB/text/chapter_bonus.xhtml", "<h1>2 Other Tales</h1><p>Bonus text must not be imported.</p>")
            archive.writestr("EPUB/text/chapter_003.xhtml", "<h1>Chapter 3: Displayed Title</h1><p>Story text long enough to count as a chapter body.</p>")

        title, chapters, errors, warnings = parse_uploads([("fallback.epub", content.getvalue())])
        self.assertEqual(title, "Fallback Book")
        self.assertFalse(errors)
        self.assertEqual([chapter.number for chapter in chapters], [1, 3])
        self.assertEqual(chapters[0].heading, "Chapter 1: Anthony Reborn")
        self.assertTrue(chapters[0].text.startswith("Chapter 1: Anthony Reborn\n\nStory text"))
        self.assertEqual(chapters[1].heading, "Chapter 3: Displayed Title")
        self.assertEqual(sum("inferred from numeric EPUB heading" in warning for warning in warnings), 1)
        self.assertTrue(any("chapter_001.xhtml" in warning for warning in warnings))

    def test_epub_tail_tales_and_letter_become_selectable_synthetic_chapters(self):
        """End-of-spine bonus documents are retained without changing narration."""
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as archive:
            archive.writestr(
                "META-INF/container.xml",
                '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>',
            )
            archive.writestr(
                "EPUB/content.opf",
                '<package xmlns="http://www.idpf.org/2007/opf"><metadata><title>ISSTH</title></metadata><manifest>'
                '<item id="front" href="front.xhtml"/><item id="one" href="chapter_1613.xhtml"/>'
                '<item id="two" href="chapter_1614.xhtml"/><item id="tale1" href="tale1.xhtml"/>'
                '<item id="tale2" href="tale2.xhtml"/><item id="tale3" href="tale3.xhtml"/>'
                '<item id="letter" href="letter.xhtml"/></manifest><spine><itemref idref="front"/>'
                '<itemref idref="one"/><itemref idref="two"/><itemref idref="tale1"/>'
                '<itemref idref="tale2"/><itemref idref="tale3"/><itemref idref="letter"/>'
                '</spine></package>',
            )
            archive.writestr("EPUB/front.xhtml", "<h1>Other Tales 0: Not Story</h1><p>Front matter.</p>")
            archive.writestr("EPUB/chapter_1613.xhtml", "<h1>Chapter 1613</h1><p>" + "Story body 1613. " * 4 + "</p>")
            archive.writestr("EPUB/chapter_1614.xhtml", "<h1>Chapter 1614</h1><p>" + "Story body 1614. " * 4 + "</p>")
            archive.writestr("EPUB/tale1.xhtml", "<h4>#1615</h4><h1>Other Tales<br/>1: Foster Father Ke</h1><p>Other Tales 1: Foster Father Ke</p><p>" + "Bonus tale body one. " * 4 + "</p>")
            archive.writestr("EPUB/tale2.xhtml", "<h1>Other Tales 2: Chu Yuyan</h1><p>" + "Bonus tale body two. " * 4 + "</p>")
            archive.writestr("EPUB/tale3.xhtml", "<h1>Other Tales 3: The Parrot And The Meat Jelly</h1><p>" + "Bonus tale body three. " * 4 + "</p>")
            archive.writestr("EPUB/letter.xhtml", "<h1>Dear Fellow Daoists</h1><p>Dear Fellow Daoists,</p><p>" + "Closing letter body. " * 4 + "</p>")

        _, chapters, errors, warnings = parse_uploads([("issth.epub", content.getvalue())])
        self.assertFalse(errors)
        self.assertEqual([chapter.number for chapter in chapters], [1613, 1614, 1615, 1616, 1617, 1618])
        self.assertEqual(
            [chapter.heading for chapter in chapters[-4:]],
            ["Other Tales 1: Foster Father Ke", "Other Tales 2: Chu Yuyan", "Other Tales 3: The Parrot And The Meat Jelly", "Dear Fellow Daoists"],
        )
        self.assertEqual(chapters[-1].text.count("Dear Fellow Daoists"), 1)
        self.assertEqual(chapters[-4].text.count("Other Tales 1: Foster Father Ke"), 1)
        self.assertTrue(any("Synthetic chapter 1615: Other Tales 1: Foster Father Ke" in warning for warning in warnings))
        self.assertTrue(any("Synthetic chapter 1618: Dear Fellow Daoists" in warning for warning in warnings))
        self.assertEqual([(section["chapter_start"], section["chapter_end"]) for section in make_sections(chapters, 50)], [(1613, 1618)])

    def test_gaps_warn_but_duplicates_block(self):
        chapters, errors, warnings = chapters_from_text("Chapter 1\n" + "a " * 20 + "\nChapter 3\n" + "b " * 20)
        self.assertFalse(errors)
        self.assertTrue(any("Missing" in warning for warning in warnings))
        _, errors, _ = chapters_from_text("Chapter 1\n" + "a " * 20 + "\nChapter 2\n" + "b " * 20 + "\nChapter 2\n" + "c " * 20)
        self.assertTrue(any("Duplicate" in error for error in errors))

    def test_sections_include_partial_tail(self):
        chapters = [Chapter(n, f"Chapter {n}", "text") for n in range(501, 556)]
        sections = make_sections(chapters, 50)
        self.assertEqual([(s["chapter_start"], s["chapter_end"]) for s in sections], [(501, 550), (551, 555)])

    def test_capped_chapter_end_counts_detected_chapters_despite_gaps(self):
        detected = list(range(1, 1400, 2))
        self.assertEqual(capped_chapter_end(detected, 201), 1399)
        self.assertEqual(capped_chapter_end([1, 3, 5], 1), 5)
        self.assertEqual(capped_chapter_end([1, 3, 5], 4), 5)
        self.assertIsNone(capped_chapter_end([1, 3, 5], 6))
        with self.assertRaisesRegex(ValueError, "positive"):
            capped_chapter_end([1], 1, 0)

    def test_assigned_names_are_persistent_and_unique(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = BookStore(root / "runtime", root / "outputs")
            imported = store.create_import("Book", [Chapter(1, "Chapter 1", "body")], [], [], 1, [("book.txt", b"Chapter 1\nbody")])
            first = store.create_job(imported, "Book", ["1"], {"output_format": "mp3"})
            second = store.create_job(imported, "Book", ["1"], {"output_format": "mp3"})
            self.assertEqual(first["sections"][0]["output_name"], "Book_ch1-1_Audiobook.mp3")
            self.assertEqual(second["sections"][0]["output_name"], "Book_ch1-1_Audiobook_2.mp3")
            self.assertEqual(store.read_job(first["id"])["sections"][0]["output_name"], "Book_ch1-1_Audiobook.mp3")

    def test_streaming_mp3_encoder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw, output = root / "audio.f32", root / "audio.mp3"
            raw.write_bytes(struct.pack("<" + "f" * 2400, *([0.0] * 2400)))
            JobRunner._encode_mp3(raw, output, 24000)
            self.assertGreater(output.stat().st_size, 100)

    def test_atomic_json_uses_independent_staging_files_for_concurrent_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            replace_barrier = threading.Barrier(2)
            real_replace = audiobook.os.replace
            calls = 0
            calls_lock = threading.Lock()
            errors = []

            def synchronized_replace(source, destination):
                nonlocal calls
                with calls_lock:
                    calls += 1
                    should_wait = calls <= 2
                if should_wait:
                    replace_barrier.wait(timeout=2)
                return real_replace(source, destination)

            def writer(index):
                try:
                    _atomic_json(manifest, {"writer": index})
                except Exception as exc:  # pragma: no cover - asserted below
                    errors.append(exc)

            with mock.patch.object(audiobook.os, "replace", synchronized_replace):
                threads = [threading.Thread(target=writer, args=(index,)) for index in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
            self.assertFalse(errors)
            self.assertIn(json.loads(manifest.read_text(encoding="utf-8"))["writer"], {0, 1})

    def test_recovery_completes_finalized_output_without_raw_pcm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = BookStore(root / "runtime", root / "outputs")
            imported = store.create_import("Book", [Chapter(1, "Chapter 1", "body")], [], [], 1, [("book.txt", b"source")])
            job = store.create_job(imported, "Book", ["1"], {"output_format": "mp3"})
            section = job["sections"][0]
            (root / "outputs" / section["output_name"]).write_bytes(b"finalized audio")

            def simulate_crash_window(current):
                current["state"] = "running"
                current_section = current["sections"][0]
                current_section.update(state="running", completed_chapters=1, pcm_bytes=16)

            store.update_job(job["id"], simulate_crash_window)
            JobRunner(store, lambda text, settings, raw: (24000, 0))

            recovered = store.read_job(job["id"])
            self.assertEqual(recovered["state"], "completed")
            self.assertEqual(recovered["sections"][0]["state"], "completed")

    def test_custom_chapter_selection_uses_fixed_numeric_buckets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = BookStore(root / "runtime", root / "outputs")
            chapters = [Chapter(n, f"Chapter {n}", "body text") for n in range(1, 9)]
            imported = store.create_import("Book", chapters, [], [], 50, [("book.txt", b"source")])
            job = store.create_job(imported, "Book", [], {"output_format": "mp3"}, [1, 2, 3, 6, 7, 8], 2)
            self.assertEqual([(s["chapter_start"], s["chapter_end"]) for s in job["sections"]], [(1, 2), (3, 3), (6, 6), (7, 8)])
            self.assertEqual([s["id"] for s in job["sections"]], ["1", "2", "3", "4"])
            with self.assertRaisesRegex(ValueError, "Unknown selected chapter"):
                store.create_job(imported, "Book", [], {"output_format": "mp3"}, [1, 99], 2)
            with self.assertRaisesRegex(ValueError, "must be positive"):
                store.create_job(imported, "Book", [], {"output_format": "mp3"}, [1], 0)

    def test_missing_displayed_labels_stay_in_fixed_numeric_buckets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = BookStore(root / "runtime", root / "outputs")
            numbers = [number for number in range(1201, 1615) if number not in {1306, 1377}]
            imported = store.create_import("Book", [Chapter(number, f"Chapter {number}", "body") for number in numbers], [], [], 50, [("book.txt", b"source")])
            job = store.create_job(imported, "Book", [], {"output_format": "mp3"}, numbers, 50, False, 1201, 1618)
            self.assertEqual(
                [(section["chapter_start"], section["chapter_end"], section["chapter_count"]) for section in job["sections"]],
                [(1201, 1250, 50), (1251, 1300, 50), (1301, 1305, 5), (1307, 1350, 44), (1351, 1376, 26), (1378, 1400, 23), (1401, 1450, 50), (1451, 1500, 50), (1501, 1550, 50), (1551, 1600, 50), (1601, 1614, 14)],
            )
            self.assertEqual(job["sections"][2]["missing_chapters"], [1306])
            self.assertEqual(job["sections"][4]["missing_chapters"], [1377])
            self.assertEqual(job["sections"][3]["output_name"], "Book_ch1307-1350_Audiobook.mp3")
            self.assertEqual(job["sections"][-1]["output_name"], "Book_ch1601-1614_Audiobook.mp3")

    def test_deselected_chapter_splits_its_fixed_numeric_bucket(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = BookStore(root / "runtime", root / "outputs")
            chapters = [Chapter(number, f"Chapter {number}", "body") for number in range(1, 101)]
            imported = store.create_import("Book", chapters, [], [], 50, [("book.txt", b"source")])
            selected = [number for number in range(1, 101) if number != 23]
            job = store.create_job(imported, "Book", [], {"output_format": "mp3"}, selected, 50, False, 1, 100)
            self.assertEqual(
                [(section["chapter_start"], section["chapter_end"], section["chapter_count"]) for section in job["sections"]],
                [(1, 22, 22), (24, 50, 27), (51, 100, 50)],
            )
            self.assertEqual(job["sections"][0]["omitted_chapters"], [23])

    def test_short_final_group_can_merge_into_previous(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = BookStore(root / "runtime", root / "outputs")
            chapters = [Chapter(n, f"Chapter {n}", "body") for n in range(1, 103)]
            imported = store.create_import("Book", chapters, [], [], 50, [("book.txt", b"source")])
            normal = store.create_job(imported, "Normal", [], {"output_format": "mp3"}, list(range(1, 103)), 50, False)
            merged = store.create_job(imported, "Merged", [], {"output_format": "mp3"}, list(range(1, 103)), 50, True)
            self.assertEqual([s["chapter_count"] for s in normal["sections"]], [50, 50, 2])
            self.assertEqual([s["chapter_count"] for s in merged["sections"]], [50, 52])
            self.assertEqual((merged["sections"][-1]["chapter_start"], merged["sections"][-1]["chapter_end"]), (51, 102))

    def test_final_tail_does_not_merge_across_an_unchecked_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = BookStore(root / "runtime", root / "outputs")
            chapters = [Chapter(n, f"Chapter {n}", "body") for n in range(1, 103)]
            imported = store.create_import("Book", chapters, [], [], 50, [("book.txt", b"source")])
            selected = [number for number in range(1, 103) if number != 101]
            job = store.create_job(imported, "Book", [], {"output_format": "mp3"}, selected, 50, True, 1, 102)
            self.assertEqual(
                [(section["chapter_start"], section["chapter_end"]) for section in job["sections"]],
                [(1, 50), (51, 100), (102, 102)],
            )


if __name__ == "__main__":
    unittest.main()
