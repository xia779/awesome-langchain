#!/usr/bin/env python3
"""
AI 漫剧音频服务集合
启动 3 个 HTTP 服务:
  - Fish Speech TTS  : http://127.0.0.1:8081
  - AudioLDM-S SFX   : http://127.0.0.1:8082
  - MusicGen BGM     : http://127.0.0.1:8083

用法:
  python audio_services.py --all          # 启动全部 3 个服务
  python audio_services.py --tts          # 只启动 TTS
  python audio_services.py --audioldm     # 只启动 AudioLDM
  python audio_services.py --musicgen     # 只启动 MusicGen
"""

import os
import sys
import json
import time
import argparse
import tempfile
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# ===== 路径配置 =====
FISH_SPEECH_ENV = "E:/fish-speech-env"
FISH_SPEECH_MODELS = "E:/fish-speech-models"
AUDIOLDM_S = "E:/my-ai-data/audioldm-s/audioldm-s-full"
MUSICGEN_SMALL = "E:/my-ai-data/musicgen-small"
OUTPUT_DIR = "E:/my-ai-data/manga_pipeline/audio_cache"

os.makedirs(OUTPUT_DIR, exist_ok=True)


# ================================================================
#  Fish Speech TTS 服务 (Port 8081)
# ================================================================

class TTSHandler(BaseHTTPRequestHandler):
    """Fish Speech TTS HTTP API"""

    _lock = threading.Lock()  # 串行化请求（Fish Speech 引擎单例）

    def log_message(self, format, *args):
        pass  # 静默日志

    def do_GET(self):
        p = urlparse(self.path).path
        if p == '/health':
            self._json(200, {"status": "ok", "service": "fish-speech-tts"})
        elif p == '/voices':
            self._list_voices()
        elif p == '/clear_gpu':
            self._clear_gpu()
        else:
            self._json(404, {"error": "Not found"})

    def _clear_gpu(self):
        import gc
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                gc.collect()
                free, total = torch.cuda.mem_get_info()
                self._json(200, {"cleared": True, "free_mb": round(free / 1024 / 1024), "total_mb": round(total / 1024 / 1024)})
            else:
                self._json(200, {"cleared": True, "note": "No CUDA available"})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/synthesize':
            self._synthesize()
        else:
            self._json(404, {"error": "Not found"})

    def _synthesize(self):
        # 读取请求体（在锁外，避免持锁时阻塞 I/O）
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length) if length > 0 else b''
            body = json.loads(raw) if raw else {}
        except:
            self._json(400, {"error": "Invalid JSON body"})
            return

        text = body.get('text', '')
        if not text:
            self._json(400, {"error": "text is required, got: " + str(body)[:100]})
            return

        # 持锁执行推理（Fish Speech 引擎不能并发）
        with TTSHandler._lock:
            self._do_synthesize(text, body)

    def _do_synthesize(self, text, body):
        output = body.get('output')
        if not output:
            output = os.path.join(OUTPUT_DIR, f"tts_{int(time.time()*1000)}.wav")

        speed = body.get('speed', 1.0)
        voice = body.get('voice', None)
        ref_audio = body.get('reference_audio', None)
        ref_text = body.get('reference_text', None)

        # 查找音色参考文件
        if voice and voice != 'default':
            ref_dir = os.path.join(FISH_SPEECH_MODELS, 'references')
            voice_file = os.path.join(ref_dir, voice + '.wav')
            if os.path.exists(voice_file):
                ref_audio = voice_file
                text_file = os.path.join(ref_dir, voice + '.txt')
                if os.path.exists(text_file):
                    with open(text_file, 'r', encoding='utf-8') as f:
                        ref_text = f.read().strip()

        try:
            # 调用 Fish Speech 推理
            sys.path.insert(0, os.path.join(FISH_SPEECH_ENV, 'Lib', 'site-packages'))
            from tts_fishspeech_import import synthesize as fish_synthesize
            result = fish_synthesize(text, ref_audio, ref_text, speed, output)
            self._json(200, result)
        except ImportError:
            # 回退: 使用子进程调用 tts_fishspeech.py
            script = r"E:\my-ai-desktop\scripts\tts_fishspeech.py"
            cmd = [
                os.path.join(FISH_SPEECH_ENV, 'Scripts', 'python.exe'),
                script,
                '--text', text,
                '--output', output,
                '--speed', str(speed),
            ]
            if ref_audio:
                cmd += ['--reference_audio', ref_audio]
            if ref_text:
                cmd += ['--reference_text', ref_text]

            import subprocess
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300,
                                      cwd=os.path.dirname(script))
                if proc.returncode == 0:
                    result = json.loads(proc.stdout.strip().split('\n')[-1])
                    self._json(200, result)
                else:
                    self._json(500, {"error": proc.stderr[-300:] if proc.stderr else "Unknown error"})
            except subprocess.TimeoutExpired:
                self._json(504, {"error": "TTS 生成超时 (300s)"})
            except Exception as e:
                self._json(500, {"error": str(e)})

    def _list_voices(self):
        ref_dir = os.path.join(FISH_SPEECH_MODELS, 'references')
        voices = [{"name": "default", "description": "默认音色"}]
        if os.path.isdir(ref_dir):
            for f in os.listdir(ref_dir):
                if f.endswith(('.wav', '.mp3', '.flac')):
                    voices.append({
                        "name": os.path.splitext(f)[0],
                        "description": f"自定义音色: {f}",
                        "audio": os.path.join(ref_dir, f)
                    })
        self._json(200, {"voices": voices})

    def _json(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))


# ================================================================
#  AudioLDM-S 音效服务 (Port 8082)
# ================================================================

class AudioLDMHandler(BaseHTTPRequestHandler):
    """AudioLDM-S 音效生成 HTTP API"""

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        p = urlparse(self.path).path
        if p == '/health':
            self._json(200, {"status": "ok", "service": "audioldm-s"})
        elif p == '/clear_gpu':
            import gc
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    gc.collect()
                    free, total = torch.cuda.mem_get_info()
                    self._json(200, {"cleared": True, "free_mb": round(free/1024/1024), "total_mb": round(total/1024/1024)})
                else:
                    self._json(200, {"cleared": True, "note": "No CUDA"})
            except Exception as e:
                self._json(500, {"error": str(e)})
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/generate':
            self._generate()
        else:
            self._json(404, {"error": "Not found"})

    def _generate(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except:
            self._json(400, {"error": "Invalid JSON"})
            return

        prompt = body.get('prompt', '')
        if not prompt:
            self._json(400, {"error": "prompt is required"})
            return

        duration = body.get('duration', 5)
        output = body.get('output')
        if not output:
            output = os.path.join(OUTPUT_DIR, f"sfx_{int(time.time()*1000)}.wav")

        try:
            import torch
            from diffusers import AudioLDMPipeline

            print(f"[AudioLDM] 加载模型...", file=sys.stderr)
            pipe = AudioLDMPipeline.from_pretrained(AUDIOLDM_S, torch_dtype=torch.float16)
            if torch.cuda.is_available():
                pipe = pipe.to("cuda")
                print(f"[AudioLDM] 使用 GPU", file=sys.stderr)
            else:
                print(f"[AudioLDM] 使用 CPU (较慢)", file=sys.stderr)

            print(f"[AudioLDM] 生成音效: {prompt}", file=sys.stderr)
            audio = pipe(prompt, num_inference_steps=200, audio_length_in_s=duration).audios[0]

            import soundfile as sf
            sf.write(output, audio, 16000)
            size = os.path.getsize(output)
            print(f"[AudioLDM] 完成: {output} ({size} bytes)", file=sys.stderr)
            self._json(200, {"success": True, "file": output, "size": size})

        except ImportError as e:
            self._json(500, {"error": f"缺少依赖: {e}. 请运行: pip install diffusers transformers torch soundfile"})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))


# ================================================================
#  MusicGen 背景音乐服务 (Port 8083)
# ================================================================

class MusicGenHandler(BaseHTTPRequestHandler):
    """MusicGen 背景音乐生成 HTTP API"""

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        p = urlparse(self.path).path
        if p == '/health':
            self._json(200, {"status": "ok", "service": "musicgen-small"})
        elif p == '/clear_gpu':
            import gc
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    gc.collect()
                    free, total = torch.cuda.mem_get_info()
                    self._json(200, {"cleared": True, "free_mb": round(free/1024/1024), "total_mb": round(total/1024/1024)})
                else:
                    self._json(200, {"cleared": True, "note": "No CUDA"})
            except Exception as e:
                self._json(500, {"error": str(e)})
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/generate':
            self._generate()
        else:
            self._json(404, {"error": "Not found"})

    def _generate(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except:
            self._json(400, {"error": "Invalid JSON"})
            return

        prompt = body.get('prompt', '')
        if not prompt:
            self._json(400, {"error": "prompt is required"})
            return

        duration = body.get('duration', 10)
        output = body.get('output')
        if not output:
            output = os.path.join(OUTPUT_DIR, f"music_{int(time.time()*1000)}.wav")

        try:
            import torch
            from transformers import AutoProcessor, MusicgenForConditionalGeneration

            print(f"[MusicGen] 加载模型...", file=sys.stderr)
            processor = AutoProcessor.from_pretrained(MUSICGEN_SMALL)
            model = MusicgenForConditionalGeneration.from_pretrained(MUSICGEN_SMALL)
            if torch.cuda.is_available():
                model = model.to("cuda")
                print(f"[MusicGen] 使用 GPU", file=sys.stderr)
            else:
                print(f"[MusicGen] 使用 CPU (较慢)", file=sys.stderr)

            # MusicGen 最大 30 秒
            duration = min(duration, 30)
            max_new_tokens = int(duration / 0.0475)  # ~21 tokens/sec

            print(f"[MusicGen] 生成音乐: {prompt} ({duration}s)", file=sys.stderr)
            inputs = processor(text=[prompt], return_tensors="pt")
            if torch.cuda.is_available():
                inputs = {k: v.to("cuda") for k, v in inputs.items()}

            audio_values = model.generate(**inputs, max_new_tokens=max_new_tokens)
            sampling_rate = model.config.audio_encoder.sampling_rate

            import soundfile as sf
            audio = audio_values[0].cpu().numpy()
            sf.write(output, audio, sampling_rate)
            size = os.path.getsize(output)
            print(f"[MusicGen] 完成: {output} ({size} bytes)", file=sys.stderr)
            self._json(200, {"success": True, "file": output, "size": size, "duration": duration})

        except ImportError as e:
            self._json(500, {"error": f"缺少依赖: {e}. 请运行: pip install transformers torch soundfile accelerate"})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))


# ================================================================
#  服务启动
# ================================================================

def start_server(name, handler_class, port):
    server = HTTPServer(('127.0.0.1', port), handler_class)
    print(f"[{name}] 启动在 http://127.0.0.1:{port}", file=sys.stderr)
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="AI 漫剧音频服务")
    parser.add_argument('--all', action='store_true', help='启动全部服务')
    parser.add_argument('--tts', action='store_true', help='只启动 TTS (8081)')
    parser.add_argument('--audioldm', action='store_true', help='只启动 AudioLDM (8082)')
    parser.add_argument('--musicgen', action='store_true', help='只启动 MusicGen (8083)')
    args = parser.parse_args()

    if not any([args.all, args.tts, args.audioldm, args.musicgen]):
        args.all = True  # 默认启动全部

    threads = []

    if args.all or args.tts:
        t = threading.Thread(target=start_server, args=('Fish Speech TTS', TTSHandler, 8081), daemon=True)
        t.start()
        threads.append(t)

    if args.all or args.audioldm:
        t = threading.Thread(target=start_server, args=('AudioLDM-S', AudioLDMHandler, 8082), daemon=True)
        t.start()
        threads.append(t)

    if args.all or args.musicgen:
        t = threading.Thread(target=start_server, args=('MusicGen', MusicGenHandler, 8083), daemon=True)
        t.start()
        threads.append(t)

    print(f"\n已启动 {len(threads)} 个音频服务:", file=sys.stderr)
    if args.all or args.tts:
        print("  TTS      -> http://127.0.0.1:8081", file=sys.stderr)
    if args.all or args.audioldm:
        print("  AudioLDM -> http://127.0.0.1:8082", file=sys.stderr)
    if args.all or args.musicgen:
        print("  MusicGen -> http://127.0.0.1:8083", file=sys.stderr)
    print("\n按 Ctrl+C 停止所有服务\n", file=sys.stderr)

    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        print("\n正在停止服务...", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
