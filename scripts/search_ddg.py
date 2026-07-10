#!/usr/bin/env python3
import argparse, json, sys

def search(query, max_results):
    ddg = None
    try:
        from ddgs import DDGS
        ddg = DDGS()
    except ImportError:
        try:
            from duckduckgo_search import DDGS
            ddg = DDGS()
        except ImportError:
            return {"success": False, "error": "ddgs not installed. Run: pip install ddgs"}
    try:
        results = ddg.text(query, max_results=max_results)
        if not results:
            return {"success": True, "results": []}
        formatted = []
        for r in results:
            formatted.append({
                "title": r.get("title", ""),
                "snippet": r.get("body", r.get("snippet", "")),
                "url": r.get("href", r.get("link", r.get("url", "")))
            })
        return {"success": True, "results": formatted}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--query", required=True)
    p.add_argument("--max-results", type=int, default=5)
    args = p.parse_args()
    r = search(args.query, args.max_results)
    print(json.dumps(r, ensure_ascii=False))

if __name__ == "__main__":
    main()
