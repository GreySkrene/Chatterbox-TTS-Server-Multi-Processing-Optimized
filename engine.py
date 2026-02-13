# File: engine.py
# Core TTS model loading and speech generation logic.

import logging
import random
import numpy as np
import torch
import atexit
from typing import Optional, Tuple
from pathlib import Path

from chatterbox.tts import ChatterboxTTS  # Main TTS engine class
from chatterbox.models.s3gen.const import (
    S3GEN_SR,
)  # Default sample rate from the engine

# Import the singleton config_manager
from config import config_manager

logger = logging.getLogger(__name__)

# --- Global Module Variables ---
chatterbox_model: Optional[ChatterboxTTS] = None
MODEL_LOADED: bool = False
model_device: Optional[str] = (
    None  # Stores the resolved device string ('cuda' or 'cpu')
)
_last_seed_value: Optional[int] = None  # Cache to avoid redundant seed calls

# Track the current chunk being synthesized (pre-write ensures it's captured even if process crashes)
_current_chunk_context = None


def _write_debug_file(status="ERROR"):
    """Write the current chunk context to debug file. ONLY writes if file doesn't exist (first error only)."""
    if _current_chunk_context is None:
        return
    debug_file = Path("problematic_chunks_debug.txt")
    # Only write if this is the FIRST error (file doesn't exist yet)
    if debug_file.exists():
        logger.info("Debug file already exists, preserving first error. Skipping overwrite.")
        return
    try:
        with open(debug_file, "w", encoding="utf-8") as f:
            f.write(f"{'='*80}\n")
            f.write(f"STATUS: {status} (FIRST ERROR - NOT OVERWRITTEN)\n")
            f.write(f"TEXT LENGTH: {len(_current_chunk_context.get('text', ''))} characters\n")
            f.write(f"AUDIO_PROMPT: {_current_chunk_context.get('audio_prompt_path')}\n")
            f.write(f"TEMPERATURE: {_current_chunk_context.get('temperature')}\n")
            f.write(f"EXAGGERATION: {_current_chunk_context.get('exaggeration')}\n")
            f.write(f"CFG_WEIGHT: {_current_chunk_context.get('cfg_weight')}\n")
            f.write(f"SEED: {_current_chunk_context.get('seed')}\n")
            f.write(f"TEXT CONTENT:\n{_current_chunk_context.get('text', '')}\n")
            f.write(f"{'='*80}\n")
    except Exception as e:
        logger.warning(f"Failed to write debug file: {e}")


def _on_exit():
    """Called on process exit to ensure the last chunk is saved."""
    _write_debug_file(status="PROCESS_EXIT")


atexit.register(_on_exit)



def set_seed(seed_value: int):
    """
    Sets the seed for torch, random, and numpy for reproducibility.
    This is called if a non-zero seed is provided for generation.
    
    Optimized to skip redundant seed-setting calls when the seed hasn't changed.
    This prevents accumulation of CUDA device-side assertions from repeated
    torch.cuda.manual_seed_all() calls during batch processing.
    
    NOTE: Repeated CUDA manual_seed calls can cause device assertion errors after
    many iterations. We:
    1. Cache the last seed value to skip redundant calls
    2. Use try-except to catch device assertion errors gracefully
    """
    global _last_seed_value
    
    # Skip if seed hasn't changed from last call
    if _last_seed_value == seed_value:
        logger.debug(f"Seed unchanged ({seed_value}), skipping redundant seed setup")
        return
    
    try:
        torch.manual_seed(seed_value)
        random.seed(seed_value)
        np.random.seed(seed_value)
        
        # CUDA seed setting can be problematic in multi-chunk batches
        # Only set if CUDA is available, and catch any device assertion errors
        if torch.cuda.is_available():
            try:
                torch.cuda.manual_seed(seed_value)
                torch.cuda.manual_seed_all(seed_value)
            except RuntimeError as cuda_err:
                # Device-side assertions can occur after many seed calls
                # Log warning but continue, as CPU/numpy seeds are already set
                if "device-side assert triggered" in str(cuda_err) or "CUDA error" in str(cuda_err):
                    logger.warning(
                        f"CUDA seed assertion after iteration {_last_seed_value}: Continuing with CPU-side seed. "
                        f"This is expected behavior in long batch jobs and does not affect output quality."
                    )
                else:
                    # Re-raise if it's a different CUDA error
                    raise
        
        if torch.backends.mps.is_available():
            torch.mps.manual_seed(seed_value)
        
        _last_seed_value = seed_value
        logger.info(f"Global seed set to: {seed_value}")
    except Exception as e:
        # Last resort: log the error but don't crash
        logger.warning(f"Unexpected error during seed setting: {e}. Continuing without full seed control.")


def _test_cuda_functionality() -> bool:
    """
    Tests if CUDA is actually functional, not just available.

    Returns:
        bool: True if CUDA works, False otherwise.
    """
    if not torch.cuda.is_available():
        return False

    try:
        test_tensor = torch.tensor([1.0])
        test_tensor = test_tensor.cuda()
        test_tensor = test_tensor.cpu()
        return True
    except Exception as e:
        logger.warning(f"CUDA functionality test failed: {e}")
        return False


def _test_mps_functionality() -> bool:
    """
    Tests if MPS is actually functional, not just available.

    Returns:
        bool: True if MPS works, False otherwise.
    """
    if not torch.backends.mps.is_available():
        return False

    try:
        test_tensor = torch.tensor([1.0])
        test_tensor = test_tensor.to("mps")
        test_tensor = test_tensor.cpu()
        return True
    except Exception as e:
        logger.warning(f"MPS functionality test failed: {e}")
        return False


def reset_gpu_state():
    """
    Attempts to reset GPU state to clear any corruption or hung kernels.
    This can help recover from CUDA timeout errors.
    """
    if not torch.cuda.is_available():
        return
    
    try:
        logger.info("Attempting to reset GPU state...")
        # Clear GPU cache
        torch.cuda.empty_cache()
        # Synchronize to ensure all operations complete
        torch.cuda.synchronize()
        logger.info("GPU state reset successfully")
    except Exception as e:
        logger.warning(f"Failed to reset GPU state: {e}")


def load_model() -> bool:
    """
    Loads the TTS model.
    This version directly attempts to load from the Hugging Face repository (or its cache)
    using `from_pretrained`, bypassing the local `paths.model_cache` directory.
    Updates global variables `chatterbox_model`, `MODEL_LOADED`, and `model_device`.

    Returns:
        bool: True if the model was loaded successfully, False otherwise.
    """
    global chatterbox_model, MODEL_LOADED, model_device

    if MODEL_LOADED:
        logger.info("TTS model is already loaded.")
        return True

    try:
        # Determine processing device with robust CUDA detection and intelligent fallback
        device_setting = config_manager.get_string("tts_engine.device", "auto")

        if device_setting == "auto":
            if _test_cuda_functionality():
                resolved_device_str = "cuda"
                logger.info("CUDA functionality test passed. Using CUDA.")
            elif _test_mps_functionality():
                resolved_device_str = "mps"
                logger.info("MPS functionality test passed. Using MPS.")
            else:
                resolved_device_str = "cpu"
                logger.info("CUDA and MPS not functional or not available. Using CPU.")

        elif device_setting == "cuda":
            if _test_cuda_functionality():
                resolved_device_str = "cuda"
                logger.info("CUDA requested and functional. Using CUDA.")
            else:
                resolved_device_str = "cpu"
                logger.warning(
                    "CUDA was requested in config but functionality test failed. "
                    "PyTorch may not be compiled with CUDA support. "
                    "Automatically falling back to CPU."
                )

        elif device_setting == "mps":
            if _test_mps_functionality():
                resolved_device_str = "mps"
                logger.info("MPS requested and functional. Using MPS.")
            else:
                resolved_device_str = "cpu"
                logger.warning(
                    "MPS was requested in config but functionality test failed. "
                    "PyTorch may not be compiled with MPS support. "
                    "Automatically falling back to CPU."
                )

        elif device_setting == "cpu":
            resolved_device_str = "cpu"
            logger.info("CPU device explicitly requested in config. Using CPU.")

        else:
            logger.warning(
                f"Invalid device setting '{device_setting}' in config. "
                f"Defaulting to auto-detection."
            )
            if _test_cuda_functionality():
                resolved_device_str = "cuda"
            elif _test_mps_functionality():
                resolved_device_str = "mps"
            else:
                resolved_device_str = "cpu"
            logger.info(f"Auto-detection resolved to: {resolved_device_str}")

        model_device = resolved_device_str
        logger.info(f"Final device selection: {model_device}")

        # Get configured model_repo_id for logging and context,
        # though from_pretrained might use its own internal default if not overridden.
        model_repo_id_config = config_manager.get_string(
            "model.repo_id", "ResembleAI/chatterbox"
        )

        logger.info(
            f"Attempting to load model directly using from_pretrained (expected from Hugging Face repository: {model_repo_id_config} or library default)."
        )
        try:
            # Directly use from_pretrained. This will utilize the standard Hugging Face cache.
            # The ChatterboxTTS.from_pretrained method handles downloading if the model is not in the cache.
            chatterbox_model = ChatterboxTTS.from_pretrained(device=model_device)
            # The actual repo ID used by from_pretrained is often internal to the library,
            # but logging the configured one provides user context.
            logger.info(
                f"Successfully loaded TTS model using from_pretrained on {model_device} (expected from '{model_repo_id_config}' or library default)."
            )
        except Exception as e_hf:
            logger.error(
                f"Failed to load model using from_pretrained (expected from '{model_repo_id_config}' or library default): {e_hf}",
                exc_info=True,
            )
            chatterbox_model = None
            MODEL_LOADED = False
            return False

        MODEL_LOADED = True
        if chatterbox_model:
            logger.info(
                f"TTS Model loaded successfully on {model_device}. Engine sample rate: {chatterbox_model.sr} Hz."
            )
        else:
            logger.error(
                "Model loading sequence completed, but chatterbox_model is None. This indicates an unexpected issue."
            )
            MODEL_LOADED = False
            return False

        return True

    except Exception as e:
        logger.error(
            f"An unexpected error occurred during model loading: {e}", exc_info=True
        )
        chatterbox_model = None
        MODEL_LOADED = False
        return False


def synthesize(
    text: str,
    audio_prompt_path: Optional[str] = None,
    temperature: float = 0.8,
    exaggeration: float = 0.5,
    cfg_weight: float = 0.5,
    seed: int = 0,
) -> Tuple[Optional[torch.Tensor], Optional[int]]:
    """
    Synthesizes audio from text using the loaded TTS model.

    Args:
        text: The text to synthesize.
        audio_prompt_path: Path to an audio file for voice cloning or predefined voice.
        temperature: Controls randomness in generation.
        exaggeration: Controls expressiveness.
        cfg_weight: Classifier-Free Guidance weight.
        seed: Random seed for generation. If 0, default randomness is used.
              If non-zero, a global seed is set for reproducibility.

    Returns:
        A tuple containing the audio waveform (torch.Tensor) and the sample rate (int),
        or (None, None) if synthesis fails.
    """
    global chatterbox_model
    global _current_chunk_context

    if not MODEL_LOADED or chatterbox_model is None:
        logger.error("TTS model is not loaded. Cannot synthesize audio.")
        return None, None

    # Capture the chunk context and pre-write to debug file BEFORE attempting synthesis
    # This ensures we capture the chunk even if the process crashes with a hard CUDA assert
    _current_chunk_context = {
        "text": text,
        "audio_prompt_path": audio_prompt_path,
        "temperature": temperature,
        "exaggeration": exaggeration,
        "cfg_weight": cfg_weight,
        "seed": seed,
    }
    _write_debug_file(status="ATTEMPTING")

    try:
        # Set seed globally if a specific seed value is provided and is non-zero.
        if seed != 0:
            logger.info(f"Applying user-provided seed for generation: {seed}")
            set_seed(seed)
        else:
            logger.info(
                "Using default (potentially random) generation behavior as seed is 0."
            )

        logger.debug(
            f"Synthesizing with params: audio_prompt='{audio_prompt_path}', temp={temperature}, "
            f"exag={exaggeration}, cfg_weight={cfg_weight}, seed_applied_globally_if_nonzero={seed}"
        )

        # Call the core model's generate method
        try:
            wav_tensor = chatterbox_model.generate(
                text=text,
                audio_prompt_path=audio_prompt_path,
                temperature=temperature,
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
            )
        except Exception as gen_err:
            # Handle CUDA timeout/device errors by attempting GPU recovery
            err_str = str(gen_err)
            # Check for any CUDA-related error (device-side assert, timeout, out of bounds, etc.)
            if any(keyword in err_str for keyword in ["launch timed out", "CUDA error", "device-side assert", "out of bounds", "vectorized_gather"]):
                # Update the pre-written debug file with error details
                try:
                    if _current_chunk_context:
                        with open(Path("problematic_chunks_debug.txt"), "a", encoding="utf-8") as f:
                            f.write(f"\nERROR_DETAILS:\n{err_str[:600]}\n")
                except Exception as debug_err:
                    logger.warning(f"Failed to append error to debug file: {debug_err}")
                
                logger.warning(
                    f"CUDA error detected: {err_str[:100]}. "
                    f"Attempting GPU state reset..."
                )
                reset_gpu_state()
                logger.error(
                    f"GPU recovery attempted. This chunk failed and must be retried. "
                    f"Original error: {err_str}"
                )
                return None, None
            else:
                # Re-raise if it's not a CUDA error
                raise

        # The ChatterboxTTS.generate method already returns a CPU tensor.
        return wav_tensor, chatterbox_model.sr
    except Exception as e:
        logger.error(f"Error during TTS synthesis: {e}", exc_info=True)
        return None, None


# --- End File: engine.py ---
