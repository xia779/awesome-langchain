#!/usr/bin/env python3
"""
VoxCPM2 TTS HTTP Service (Port 8084)
Model stays resident in GPU memory, avoids cold-start per request.

Usage:
  python tts_voxcpm_service.py                # Start service (port 8084)
  python tts_voxcpm_service.py --model 0.5b   # Use 0.5B lightweight (5GB VRAM)
  python tts_voxcpm_service.py --model 2b     # Use 2B full version (8GB VRAM, default)
  python tts_voxcpm_service.py --preload      # Preload model at startup

Dependencies:
  pip install voxcpm torch torchaudio

Model download:
  First run auto-downloads from HuggingFace/ModelScope.
  Or specify local path: --model-path E:/voxcpm-models/VoxCPM2
"""

import os
import sys
import json
import time
import argparse
import tempfile
import threading
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# ===== Configuration =====
DEFAULT_PORT = 8084
MODEL_DIR = os.environ.get("VOXCPM_MODEL_DIR", "E:/voxcpm-models")
OUTPUT_DIR = "E:/my-ai-data/voxcpm_cache"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Global model instance
_model = None
_model_lock = threading.Lock()
_model_config = {"version": "2b", "loaded": False, "load_time": 0}


def get_device():
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def load_model(version="2b", model_path=None):
    """Lazy-load VoxCPM model (stays resident in VRAM)"""
    global _model, _model_config
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model

        print(f"[voxcpm] Loading VoxCPM ({version})...", file=sys.stderr)
        t0 = time.time()
        device = get_device()
        print(f"[voxcpm] Device: {device}", file=sys.stderr)

        try:
            from voxcpm import VoxCPM as VoxCPMModel

            if model_path and os.path.isdir(model_path):
                print(f"[voxcpm] Loading from local path: {model_path}", file=sys.stderr)
                # load_denoiser=False: skip the ModelScope zipenhancer download; it is
                # only used by generate(denoise=True) which this service does not call.
                _model = VoxCPMModel.from_pretrained(model_path, device=device, load_denoiser=False)
            elif version == "0.5b":
                print("[voxcpm] Downloading/loading VoxCPM-0.5B...", file=sys.stderr)
                _model = VoxCPMModel.from_pretrained(
                    "openbmb/VoxCPM-0.5B", device=device, cache_dir=MODEL_DIR, load_denoiser=False
                )
            else:
                print("[voxcpm] Downloading/loading VoxCPM2 (2B)...", file=sys.stderr)
                _model = VoxCPMModel.from_pretrained(
                    "openbmb/VoxCPM2", device=device, cache_dir=MODEL_DIR, load_denoiser=False
                )

            elapsed = time.time() - t0
            _model_config = {"version": version, "loaded": True, "load_time": round(elapsed, 1)}
            print(f"[voxcpm] Model loaded ({elapsed:.1f}s)", file=sys.stderr)

        except ImportError as e:
            print("[voxcpm] ERROR: voxcpm package not installed. Run: pip install voxcpm", file=sys.stderr)
            print(f"[voxcpm] ImportError: {e}", file=sys.stderr)
            raise
        except Exception as e:
            print(f"[voxcpm] Model load failed: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            raise

    return _model


def synthesize(text, reference_audio=None, reference_text=None,
               speed=1.0, output=None, voice_design=None):
    """
    Synthesize speech.

    Args:
      text: Text to synthesize
      reference_audio: Reference audio path (zero-shot clone)
      reference_text: Transcript of reference audio
      speed: Speech rate (0.5-2.0)
      output: Output file path
      voice_design: Natural language voice description (e.g. "deep husky middle-aged male")
    """
    model = load_model()

    if not output:
        output = os.path.join(OUTPUT_DIR, f"voxcpm_{int(time.time()*1000)}.wav")

    try:
        import numpy as np
        import soundfile as sf

        # Build generation kwargs for the voxcpm 2.x generate() API:
        #   generate(text, reference_wav_path=...) -> np.ndarray (1D float32 waveform)
        # voxcpm 2.x has NO `speed` / `voice_design` params, and voice cloning only
        # needs the reference audio (reference_wav_path); no transcript required.
        # (speed / reference_text / voice_design are kept in the signature for HTTP
        #  backward-compat but are not forwarded to generate().)
        gen_kwargs = {"text": text}

        # Zero-shot voice clone: reference audio path
        if reference_audio and os.path.exists(reference_audio):
            gen_kwargs["reference_wav_path"] = reference_audio

        print(f"[voxcpm] Synthesizing...", file=sys.stderr)
        t0 = time.time()

        # VoxCPM generate API (returns a 1D numpy waveform on CPU)
        audio_data = model.generate(**gen_kwargs)

        elapsed = time.time() - t0
        print(f"[voxcpm] Done ({elapsed:.2f}s)", file=sys.stderr)

        # Save audio. voxcpm 2.x generate() returns a 1D np.ndarray (float32, CPU).
        # Read the real sample rate from the model (2B=48kHz, 0.5B=16kHz).
        # Write with soundfile (libsndfile) instead of torchaudio.save: torchaudio
        # 2.11 routes save() through torchcodec, which requires FFmpeg (absent here).
        sample_rate = getattr(getattr(model, "tts_model", None), "sample_rate", 48000)
        if isinstance(audio_data, tuple):
            # (sample_rate, numpy_array) format
            sample_rate, audio_np = audio_data
        elif hasattr(audio_data, "numpy"):
            # torch.Tensor format
            audio_np = audio_data.detach().cpu().numpy()
        else:
            # numpy ndarray (the normal voxcpm 2.x return type)
            audio_np = audio_data
        audio_np = np.array(audio_np, dtype=np.float32)
        if audio_np.ndim > 1:
            audio_np = audio_np.squeeze()
        sf.write(output, audio_np, sample_rate)

        size = os.path.getsize(output)
        return {"success": True, "file": output, "size": size, "time": round(elapsed, 2)}

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        return {"success": False, "error": str(e)}


def list_voices():
    """List available voices (reference audio directory)"""
    ref_dir = os.path.join(MODEL_DIR, "references")
    voices = [{"name": "default", "description": "Default voice (no clone)"}]
    if os.path.isdir(ref_dir):
        for f in os.listdir(ref_dir):
            if f.endswith((".wav", ".mp3", ".flac", ".ogg", ".m4a")):
                name = os.path.splitext(f)[0]
                voices.append({
                    "name": name,
                    "description": f"Clone voice: {f}",
                    "audio": os.path.join(ref_dir, f)
                })
    return voices


def clear_gpu():
    """Clear GPU memory cache"""
    import gc
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            gc.collect()
            free, total = torch.cuda.mem_get_info()
            return {"cleared": True, "free_mb": round(free / 1024 / 1024),
                    "total_mb": round(total / 1024 / 1024)}
        return {"cleared": True, "note": "No CUDA"}
    except Exception as e:
        return {"error": str(e)}


# ================================================================
#  HTTP Service
# ================================================================

class VoxCPMHandler(BaseHTTPRequestHandler):
    """VoxCPM TTS HTTP API (OpenAI-compatible style)"""

    _lock = threading.Lock()

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/health":
            self._json(200, {"status": "ok", "service": "voxcpm-tts", "model": _model_config})
        elif p == "/voices":
            self._json(200, {"voices": list_voices()})
        elif p == "/clear_gpu":
            self._json(200, clear_gpu())
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self):
        p = urlparse(self.path).path
        if p in ("/synthesize", "/v1/audio/speech"):
            self._synthesize()
        else:
            self._json(404, {"error": "Not found"})

    def _synthesize(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

            text = body.get("text", "")
            if not text:
                self._json(400, {"success": False, "error": "Missing text parameter"})
                return

            speed = float(body.get("speed", 1.0))
            voice = body.get("voice", "default")
            reference_audio = body.get("reference_audio", None)
            reference_text = body.get("reference_text", None)
            voice_design = body.get("voice_design", None)
            output = body.get("output", None)

            # Voice name -> reference audio path
            if voice and voice != "default" and not reference_audio:
                ref_dir = os.path.join(MODEL_DIR, "references")
                for ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
                    candidate = os.path.join(ref_dir, voice + ext)
                    if os.path.exists(candidate):
                        reference_audio = candidate
                        txt_file = os.path.join(ref_dir, voice + ".txt")
                        if os.path.exists(txt_file) and not reference_text:
                            with open(txt_file, "r", encoding="utf-8") as f:
                                reference_text = f.read().strip()
                        break

            # Serialize inference (GPU single-thread)
            with self._lock:
                result = synthesize(
                    text=text,
                    reference_audio=reference_audio,
                    reference_text=reference_text,
                    speed=speed,
                    output=output,
                    voice_design=voice_design
                )

            self._json(200, result)

        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            self._json(500, {"success": False, "error": str(e)})

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def main():
    parser = argparse.ArgumentParser(description="VoxCPM2 TTS HTTP Service")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", choices=["0.5b", "2b"], default="2b",
                        help="Model version: 0.5b (5GB VRAM) or 2b (8GB VRAM, default)")
    parser.add_argument("--model-path", default=None,
                        help="Local model path (skip download)")
    parser.add_argument("--preload", action="store_true",
                        help="Preload model at startup (otherwise loads on first request)")
    args = parser.parse_args()

    print("[voxcpm] VoxCPM TTS Service starting...", file=sys.stderr)
    print(f"[voxcpm] Port: {args.port}, Model: {args.model}", file=sys.stderr)
    print(f"[voxcpm] Model dir: {MODEL_DIR}", file=sys.stderr)
    print(f"[voxcpm] Output dir: {OUTPUT_DIR}", file=sys.stderr)

    if args.preload:
        print("[voxcpm] Preloading model...", file=sys.stderr)
        load_model(version=args.model, model_path=args.model_path)

    server = HTTPServer(("127.0.0.1", args.port), VoxCPMHandler)
    print(f"[voxcpm] Service ready: http://127.0.0.1:{args.port}", file=sys.stderr)
    print("[voxcpm] Endpoints: POST /synthesize | POST /v1/audio/speech", file=sys.stderr)
    print("[voxcpm] Health: GET /health", file=sys.stderr)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[voxcpm] Service stopped", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()
