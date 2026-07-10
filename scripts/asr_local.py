#!/usr/bin/env python3
import argparse, json, os, sys

def transcribe(input_file, model_size, language, device):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {"success": False, "error": "faster-whisper not installed"}
    try:
        model = WhisperModel(model_size, device=device, compute_type="int8")
        segs, info = model.transcribe(input_file, language=language or None, beam_size=5, vad_filter=True)
        segments = []
        full_text = ""
        for s in segs:
            segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
            full_text += s.text
        return {"success": True, "text": full_text.strip(), "language": info.language,
                "language_prob": round(info.language_probability, 2), "segments": segments, "duration": round(info.duration, 2)}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--model", default="base")
    p.add_argument("--language", default="zh")
    p.add_argument("--device", default="cpu")
    args = p.parse_args()
    if not os.path.exists(args.input):
        print(json.dumps({"success": False, "error": "File not found: " + args.input}))
        return
    r = transcribe(args.input, args.model, args.language, args.device)
    print(json.dumps(r, ensure_ascii=False))

if __name__ == "__main__":
    main()
