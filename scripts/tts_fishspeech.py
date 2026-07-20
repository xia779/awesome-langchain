#!/usr/bin/env python3
"""
Fish Speech 1.5 本地 TTS 服务脚本
使用 Fish Speech 官方推理 API
"""
import argparse
import json
import os
import sys
import tempfile
import time

# 确保 .project-root 存在
_site_packages = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'fish-speech-env', 'Lib', 'site-packages')
if os.path.isdir(_site_packages):
    _pr = os.path.join(_site_packages, '.project-root')
    if not os.path.exists(_pr):
        open(_pr, 'w').close()

# 模型目录
MODEL_DIR = os.environ.get("FISH_SPEECH_MODEL_DIR", "E:/fish-speech-models")

# 全局模型实例
_engine = None
_args_cache = {}

def get_device():
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except:
        pass
    return "cpu"

def load_engine():
    """惰性加载 Fish Speech 推理引擎"""
    global _engine
    if _engine is not None:
        return _engine

    print("[fish-tts] 加载模型中...", file=sys.stderr)
    t0 = time.time()

    import torch
    from fish_speech.inference_engine import TTSInferenceEngine
    from fish_speech.models.dac.inference import load_model as load_decoder_model
    from fish_speech.models.text2semantic.inference import launch_thread_safe_queue

    device = get_device()
    precision = torch.bfloat16 if device == "cuda" else torch.float32
    half = device == "cuda"

    print(f"[fish-tts] 设备: {device}, 精度: {precision}", file=sys.stderr)

    # 模型路径（LLaMA 需要传目录，from_pretrained 会自动找 config.json + model.pth）
    llama_path = MODEL_DIR
    decoder_path = os.path.join(MODEL_DIR, "codec.pth")

    # 加载 LLaMA 模型（线程安全队列）
    print("[fish-tts] 加载 LLaMA 模型...", file=sys.stderr)
    llama_queue = launch_thread_safe_queue(
        checkpoint_path=llama_path,
        device=device,
        precision=precision,
        compile=False,
    )

    # 加载 DAC 解码器
    print("[fish-tts] 加载 DAC 解码器...", file=sys.stderr)
    decoder_model = load_decoder_model(
        config_name="modded_dac_vq",
        checkpoint_path=decoder_path,
        device=device,
    )

    # 创建推理引擎
    _engine = TTSInferenceEngine(
        llama_queue=llama_queue,
        decoder_model=decoder_model,
        precision=precision,
        compile=False,
    )

    # 预热
    print("[fish-tts] 预热模型...", file=sys.stderr)
    from fish_speech.utils.schema import ServeTTSRequest
    warm_req = ServeTTSRequest(
        text="测试。",
        references=[],
        max_new_tokens=256,
        temperature=0.7,
        top_p=0.8,
        repetition_penalty=1.1,
        format="wav",
    )
    for _ in _engine.inference(warm_req):
        pass

    elapsed = time.time() - t0
    print(f"[fish-tts] 模型加载完成 ({elapsed:.1f}s)", file=sys.stderr)
    return _engine


def synthesize(text, reference_audio=None, reference_text=None, speed=1.0, output=None):
    """合成语音"""
    engine = load_engine()

    if not output:
        output = os.path.join(tempfile.gettempdir(), f"fish_tts_{os.getpid()}.wav")

    import torch
    import torchaudio
    import numpy as np
    from fish_speech.utils.schema import ServeTTSRequest, ServeReferenceAudio

    # 构建参考音频
    references = []
    if reference_audio and os.path.exists(reference_audio):
        with open(reference_audio, "rb") as f:
            audio_bytes = f.read()
        ref_text = reference_text or ""
        references.append(ServeReferenceAudio(audio=audio_bytes, text=ref_text))

    # 根据速度调整 max_new_tokens
    max_tokens = int(1024 / speed) if speed > 0 else 1024

    # 构建请求
    req = ServeTTSRequest(
        text=text,
        references=references,
        max_new_tokens=max_tokens,
        temperature=0.7,
        top_p=0.8,
        repetition_penalty=1.1,
        format="wav",
        streaming=False,
    )

    # 直接使用引擎推理（返回 InferenceResult 对象）
    audio_chunks = []
    sample_rate = 44100
    for result in engine.inference(req):
        if result.code in ("audio", "segment", "final"):
            if isinstance(result.audio, tuple):
                sr, audio = result.audio
                sample_rate = sr
                audio_chunks.append(audio)
        elif result.code == "error":
            raise Exception(f"推理错误: {result.error}")

    if not audio_chunks:
        raise Exception("推理未返回音频数据")

    # 拼接并保存
    full_audio = np.concatenate(audio_chunks, axis=-1) if len(audio_chunks) > 1 else audio_chunks[0]
    audio_tensor = torch.tensor(full_audio, dtype=torch.float32).unsqueeze(0)
    torchaudio.save(output, audio_tensor, sample_rate=sample_rate)

    size = os.path.getsize(output)
    return {"success": True, "file": output, "size": size}


def list_voices():
    """列出可用音色"""
    ref_dir = os.path.join(MODEL_DIR, "references")
    voices = [{"name": "default", "gender": "female", "description": "默认音色"}]
    if os.path.isdir(ref_dir):
        for f in os.listdir(ref_dir):
            if f.endswith(('.wav', '.mp3', '.flac', '.ogg')):
                name = os.path.splitext(f)[0]
                voices.append({
                    "name": name, "gender": "unknown",
                    "description": f"自定义音色: {f}",
                    "audio": os.path.join(ref_dir, f)
                })
    return voices


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text", default="")
    p.add_argument("--output", default=None)
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--reference_audio", default=None)
    p.add_argument("--reference_text", default=None)
    p.add_argument("--voice", default=None)
    p.add_argument("--list-voices", action="store_true")
    args = p.parse_args()

    if args.list_voices:
        voices = list_voices()
        print(json.dumps({"success": True, "voices": voices}, ensure_ascii=False))
        return

    if not args.text:
        print(json.dumps({"success": False, "error": "No text provided"}))
        return

    ref_audio = args.reference_audio
    ref_text = args.reference_text
    if args.voice and args.voice != "default":
        ref_dir = os.path.join(MODEL_DIR, "references")
        voice_file = os.path.join(ref_dir, args.voice + ".wav")
        if os.path.exists(voice_file):
            ref_audio = voice_file
            text_file = os.path.join(ref_dir, args.voice + ".txt")
            if os.path.exists(text_file):
                with open(text_file, "r", encoding="utf-8") as f:
                    ref_text = f.read().strip()

    try:
        result = synthesize(args.text, ref_audio, ref_text, args.speed, args.output)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        import traceback
        traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
