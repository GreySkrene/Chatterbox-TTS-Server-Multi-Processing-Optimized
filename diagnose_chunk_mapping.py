import sys
from pathlib import Path
import yaml

TEXT_PATH = Path("temp.txt")
OUT_DIR = Path(".")
CHUNK_INDEX = 1282  # 1-based index to inspect
PROBLEM_OUT = OUT_DIR / f"problem_chunk_{CHUNK_INDEX}.txt"


# load chunk_size from config.yaml if present, fallback to 410
cfg_path = Path("config.yaml")
if cfg_path.exists():
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    chunk_size = int(cfg.get("ui_state", {}).get("last_chunk_size", cfg.get("generation_defaults", {}).get("chunk_size", 410)))
else:
    chunk_size = 410

text = TEXT_PATH.read_text(encoding="utf-8")

# naive chunker that mirrors repo behavior: split on double-newline segments,
# put segments together until chunk_size chars; if a single segment > chunk_size, it forms its own chunk.
segments = [s.strip() for s in text.split("\n\n") if s.strip()]
chunks = []
cur = ""
for seg in segments:
    if len(seg) > chunk_size:
        if cur:
            chunks.append(cur)
            cur = ""
        chunks.append(seg)
    else:
        if not cur:
            cur = seg
        elif len(cur) + 2 + len(seg) <= chunk_size:
            cur = cur + "\n\n" + seg
        else:
            chunks.append(cur)
            cur = seg
if cur:
    chunks.append(cur)

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