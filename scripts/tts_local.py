#!/usr/bin/env python3
import argparse, asyncio, json, os, tempfile, sys

async def synthesize(text, voice, speed, output):
    try:
        import edge_tts
    except ImportError:
        return {"success": False, "error": "edge-tts not installed"}
    rate_pct = int((speed - 1.0) * 100)
    rate_str = f"+{rate_pct}%" if rate_pct >= 0 else f"{rate_pct}%"
    try:
        comm = edge_tts.Communicate(text, voice, rate=rate_str)
        await comm.save(output)
        size = os.path.getsize(output)
        return {"success": True, "file": output, "size": size}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def list_voices():
    import edge_tts
    voices = await edge_tts.list_voices()
    zh = [v for v in voices if v["Locale"].startswith("zh-")]
    return [{"name": v["ShortName"], "gender": v["Gender"], "locale": v["Locale"]} for v in zh]

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text", default="")
    p.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--output", default=None)
    p.add_argument("--list-voices", action="store_true")
    args = p.parse_args()
    if args.list_voices:
        r = asyncio.run(list_voices())
        print(json.dumps({"success": True, "voices": r}, ensure_ascii=False))
        return
    if not args.text:
        print(json.dumps({"success": False, "error": "No text provided"}))
        return
    if not args.output:
        args.output = os.path.join(tempfile.gettempdir(), f"tts_{os.getpid()}.mp3")
    r = asyncio.run(synthesize(args.text, args.voice, args.speed, args.output))
    print(json.dumps(r, ensure_ascii=False))

if __name__ == "__main__":
    main()
