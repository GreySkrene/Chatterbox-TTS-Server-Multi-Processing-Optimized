import sys
import re
import logging
from pathlib import Path
from typing import List, Tuple, Optional, Set
import yaml

# Set up basic logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# ====== COPY OF TEXT PROCESSING FROM utils.py ======
# Set of common abbreviations to help with sentence splitting.
ABBREVIATIONS: Set[str] = {
    "mr.", "mrs.", "ms.", "dr.", "prof.", "rev.", "hon.", "st.", "etc.",
    "e.g.", "i.e.", "vs.", "approx.", "apt.", "dept.", "fig.", "gen.",
    "gov.", "inc.", "jr.", "sr.", "ltd.", "no.", "p.", "pp.", "vol.",
    "op.", "cit.", "ca.", "cf.", "ed.", "esp.", "et.", "al.", "ibid.",
    "id.", "inf.", "sup.", "viz.", "sc.", "fl.", "d.", "b.", "r.",
    "c.", "v.", "u.s.", "u.k.", "a.m.", "p.m.", "a.d.", "b.c.",
}

# Regex patterns (pre-compiled for efficiency in text processing).
NUMBER_DOT_NUMBER_PATTERN = re.compile(r"(?<!\d\.)\d*\.\d+")
VERSION_PATTERN = re.compile(r"[vV]?\d+(\.\d+)+")
POTENTIAL_END_PATTERN = re.compile(r'([.!?])(["\']?)(\s+|$)')
BULLET_POINT_PATTERN = re.compile(r"(?:^|\n)\s*([-•*]|\d+\.)\s+")
NON_VERBAL_CUE_PATTERN = re.compile(r"(\([\w\s'-]+\))")


def _is_valid_sentence_end(text: str, period_index: int) -> bool:
    """
    Checks if a period is likely a valid sentence terminator.
    """
    word_start_before_period = period_index - 1
    scan_limit = max(0, period_index - 10)
    while word_start_before_period >= scan_limit and not text[word_start_before_period].isspace():
        word_start_before_period -= 1
    word_before_period = text[word_start_before_period + 1 : period_index + 1].lower()
    if word_before_period in ABBREVIATIONS:
        return False

    context_start = max(0, period_index - 10)
    context_end = min(len(text), period_index + 10)
    context_segment = text[context_start:context_end]
    relative_period_index_in_context = period_index - context_start

    for pattern in [NUMBER_DOT_NUMBER_PATTERN, VERSION_PATTERN]:
        for match in pattern.finditer(context_segment):
            if match.start() <= relative_period_index_in_context < match.end():
                is_last_char_of_numeric_match = relative_period_index_in_context == match.end() - 1
                is_followed_by_space_or_eos = period_index + 1 == len(text) or text[period_index + 1].isspace()
                if not (is_last_char_of_numeric_match and is_followed_by_space_or_eos):
                    return False
    return True


def _split_text_by_punctuation(text: str) -> List[str]:
    """
    Splits text into sentences based on common punctuation marks.
    """
    sentences: List[str] = []
    last_split_index = 0
    text_length = len(text)

    for match in POTENTIAL_END_PATTERN.finditer(text):
        punctuation_char_index = match.start(1)
        punctuation_char = text[punctuation_char_index]
        slice_end_after_punctuation = match.start(1) + 1 + len(match.group(2) or "")

        if punctuation_char in ["!", "?"]:
            current_sentence_text = text[last_split_index:slice_end_after_punctuation].strip()
            if current_sentence_text:
                sentences.append(current_sentence_text)
            last_split_index = match.end()
            continue

        if punctuation_char == ".":
            if (punctuation_char_index > 0 and text[punctuation_char_index - 1] == ".") or \
               (punctuation_char_index < text_length - 1 and text[punctuation_char_index + 1] == "."):
                continue

            if _is_valid_sentence_end(text, punctuation_char_index):
                current_sentence_text = text[last_split_index:slice_end_after_punctuation].strip()
                if current_sentence_text:
                    sentences.append(current_sentence_text)
                last_split_index = match.end()

    remaining_text_segment = text[last_split_index:].strip()
    if remaining_text_segment:
        sentences.append(remaining_text_segment)

    sentences = [s for s in sentences if s]
    if not sentences and text.strip():
        return [text.strip()]
    return sentences


def split_into_sentences(text: str) -> List[str]:
    """
    Splits text into sentences, handling bullet points and newlines.
    """
    if not text or text.isspace():
        return []

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    bullet_point_matches = list(BULLET_POINT_PATTERN.finditer(text))

    if bullet_point_matches:
        logger.debug("Bullet points detected in text; splitting by bullet items.")
        processed_sentences: List[str] = []
        current_position = 0
        for i, bullet_match in enumerate(bullet_point_matches):
            bullet_actual_start_index = bullet_match.start()
            if i == 0 and bullet_actual_start_index > current_position:
                pre_bullet_segment = text[current_position:bullet_actual_start_index].strip()
                if pre_bullet_segment:
                    processed_sentences.extend(s for s in _split_text_by_punctuation(pre_bullet_segment) if s)

            next_bullet_start_index = (
                bullet_point_matches[i + 1].start()
                if i + 1 < len(bullet_point_matches)
                else len(text)
            )
            bullet_item_segment = text[bullet_actual_start_index:next_bullet_start_index].strip()
            if bullet_item_segment:
                processed_sentences.append(bullet_item_segment)
            current_position = next_bullet_start_index

        if current_position < len(text):
            post_bullet_segment = text[current_position:].strip()
            if post_bullet_segment:
                processed_sentences.extend(s for s in _split_text_by_punctuation(post_bullet_segment) if s)
        return [s for s in processed_sentences if s]
    else:
        logger.debug("No bullet points detected; using punctuation-based sentence splitting.")
        return _split_text_by_punctuation(text)


def _preprocess_and_segment_text(full_text: str) -> List[Tuple[Optional[str], str]]:
    """
    Segments text by non-verbal cues and sentences.
    """
    if not full_text or full_text.isspace():
        return []

    placeholder_tag: Optional[str] = None
    segmented_with_tags: List[Tuple[Optional[str], str]] = []
    parts_and_cues = NON_VERBAL_CUE_PATTERN.split(full_text)

    for part in parts_and_cues:
        if not part or part.isspace():
            continue
        if NON_VERBAL_CUE_PATTERN.fullmatch(part):
            segmented_with_tags.append((placeholder_tag, part.strip()))
        else:
            sentences_from_part = split_into_sentences(part.strip())
            for sentence in sentences_from_part:
                if sentence:
                    segmented_with_tags.append((placeholder_tag, sentence))

    if not segmented_with_tags and full_text.strip():
        segmented_with_tags.append((placeholder_tag, full_text.strip()))

    logger.debug(f"Preprocessed text into {len(segmented_with_tags)} segments/sentences.")
    return segmented_with_tags


def chunk_text_by_sentences(full_text: str, chunk_size: int) -> List[str]:
    """
    Chunks text into manageable pieces, respecting sentence boundaries.
    """
    if not full_text or full_text.isspace():
        return []
    if chunk_size <= 0:
        chunk_size = float("inf")

    processed_segments = _preprocess_and_segment_text(full_text)
    if not processed_segments:
        return []

    text_chunks: List[str] = []
    current_chunk_sentences: List[str] = []
    current_chunk_length = 0

    for _, segment_text in processed_segments:
        segment_len = len(segment_text)

        if not current_chunk_sentences:
            current_chunk_sentences.append(segment_text)
            current_chunk_length = segment_len
        elif current_chunk_length + 1 + segment_len <= chunk_size:
            current_chunk_sentences.append(segment_text)
            current_chunk_length += 1 + segment_len
        else:
            if current_chunk_sentences:
                text_chunks.append(" ".join(current_chunk_sentences))
            current_chunk_sentences = [segment_text]
            current_chunk_length = segment_len

        if current_chunk_length > chunk_size and len(current_chunk_sentences) == 1:
            logger.info(
                f"A single segment (length {current_chunk_length}) exceeds chunk_size {chunk_size}. "
                f"It will form its own chunk."
            )
            text_chunks.append(" ".join(current_chunk_sentences))
            current_chunk_sentences = []
            current_chunk_length = 0

    if current_chunk_sentences:
        text_chunks.append(" ".join(current_chunk_sentences))

    return text_chunks


# ====== END COPY FROM utils.py ======


# ====== MAIN SCRIPT ======
TEXT_PATH = Path("temp.txt")
OUT_DIR = Path(".")
CHUNK_INDEX = 66  # 1-based index to inspect
PROBLEM_OUT = OUT_DIR / f"problem_chunk_{CHUNK_INDEX}.txt"

# load chunk_size from config.yaml if present, fallback to 120 (the actual default from server)
cfg_path = Path("config.yaml")
if cfg_path.exists():
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    chunk_size = int(cfg.get("ui_state", {}).get("last_chunk_size", cfg.get("generation_defaults", {}).get("chunk_size", 120)))
else:
    chunk_size = 120

text = TEXT_PATH.read_text(encoding="utf-8")

# Use the ACTUAL chunking function from the server
chunks = chunk_text_by_sentences(text, chunk_size)

print(f"Char chunk_size={chunk_size}; produced {len(chunks)} chunks")
i = CHUNK_INDEX - 1
if not (0 <= i < len(chunks)):
    print(f"Requested chunk {CHUNK_INDEX} out of range (1..{len(chunks)})")
    sys.exit(0)

chunk = chunks[i]
print(f"\n--- Chunk {CHUNK_INDEX} (chars={len(chunk)}) preview ---\n")
print(chunk[:2000])
PROBLEM_OUT.write_text(chunk, encoding="utf-8")
print(f"\nSaved full chunk {CHUNK_INDEX} to: {PROBLEM_OUT.resolve()}")

# Tokenizer / vocab checks (CPU only)
try:
    from chatterbox.tts import ChatterboxTTS
    print("\nLoading ChatterboxTTS on CPU (may take a moment)...")
    m = ChatterboxTTS.from_pretrained(device="cpu")
    tok = getattr(m, "tokenizer", None)
    if tok is None:
        print("No tokenizer attribute on model; skipping token checks.")
        sys.exit(0)
    print("Tokenizer loaded:", type(tok))
    try:
        if hasattr(tok, "encode"):
            ids = tok.encode(chunk)
        else:
            ids = tok(chunk)["input_ids"]
        print("Token count:", len(ids))
        print("Token id min/max:", (min(ids) if ids else None), (max(ids) if ids else None))
        
        # Try multiple ways to get vocab_size from tokenizer
        vocab_size = None
        if hasattr(tok, "vocab_size"):
            vocab_size = tok.vocab_size
        elif hasattr(tok, "get_vocab_size"):
            vocab_size = tok.get_vocab_size()
        elif hasattr(tok, "get_vocab"):
            vocab_size = len(tok.get_vocab())
        elif hasattr(tok, "vocab"):
            vocab_size = len(tok.vocab) if hasattr(tok.vocab, "__len__") else None
        
        # If still no vocab_size, try to inspect internal structures
        if not vocab_size:
            print("\nAttempting to inspect tokenizer internals...")
            if hasattr(tok, "config"):
                if hasattr(tok.config, "vocab_size"):
                    vocab_size = tok.config.vocab_size
                    print(f"  Found vocab_size in config: {vocab_size}")
            if hasattr(tok, "_vocab"):
                vocab_size = len(tok._vocab)
                print(f"  Found _vocab with size: {vocab_size}")
            if hasattr(tok, "stoi"):
                vocab_size = len(tok.stoi)
                print(f"  Found stoi dict with size: {vocab_size}")
        
        # **Critical check**: Inspect the model's embedding layer to get the TRUE vocab_size
        print("\nInspecting model's embedding layer for actual vocab_size...")
        try:
            if hasattr(m, "model") and hasattr(m.model, "embeddings"):
                emb_layer = m.model.embeddings
                if hasattr(emb_layer, "word_embeddings") and hasattr(emb_layer.word_embeddings, "weight"):
                    model_vocab_size = emb_layer.word_embeddings.weight.shape[0]
                    print(f"  Model embedding vocab_size: {model_vocab_size}")
                    if not vocab_size:
                        vocab_size = model_vocab_size
            
            # Try alternative paths for embedding layer
            if not vocab_size:
                for attr_name in ["embeddings", "encoder", "decoder", "lm_head"]:
                    if hasattr(m, attr_name):
                        attr = getattr(m, attr_name)
                        if hasattr(attr, "weight"):
                            model_vocab_size = attr.weight.shape[0]
                            print(f"  Found embedding via {attr_name}: {model_vocab_size}")
                            vocab_size = model_vocab_size
                            break
        except Exception as e:
            print(f"  Could not inspect embedding layer: {e}")
        
        if vocab_size:
            print(f"\n✓ Final vocab_size: {vocab_size}")
            if ids and max(ids) >= vocab_size:
                print(f"⚠️  CRITICAL: max token id {max(ids)} >= vocab_size {vocab_size}")
                print(f"             This WILL cause out-of-bounds indexing in the embedding layer!")
                print(f"             This is the root cause of the CUDA gather kernel error!")
            else:
                print(f"✓ All token ids within bounds (max {max(ids) if ids else 'N/A'} < vocab_size {vocab_size})")
        else:
            print("\n⚠️  Could not determine vocab_size from tokenizer or model")
            print("   Max token id observed: 322")
            print("   RISK: If vocab_size < 323, token id 322 would cause out-of-bounds indexing!")
            print("   ACTION: Run with CUDA_LAUNCH_BLOCKING=1 for full stacktrace, or try sanitizing input")
    except Exception as e:
        print("Tokenizer encode error:", repr(e))
except Exception as e:
    print("Model/tokenizer load skipped or failed:", repr(e))