#!/usr/bin/env python3
import argparse, json, re, sys, urllib.request, urllib.parse

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

def search(query, max_results):
    try:
        encoded = urllib.parse.quote_plus(query)
        url = "https://cn.bing.com/search?q=" + encoded + "&count=" + str(max_results)
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
        })
        resp = urllib.request.urlopen(req, timeout=15)
        html = resp.read().decode("utf-8", errors="ignore")
        results = []
        parts = html.split('class="b_algo"')
        for part in parts[1:max_results+1]:
            h2_m = re.search(r'<h2[^>]*>.*?<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', part, re.DOTALL)
            if not h2_m:
                continue
            url_r = h2_m.group(1)
            title_r = re.sub(r'<[^>]+>', "", h2_m.group(2)).strip()
            snippet_r = ""
            cap_m = re.search(r'class="b_caption"', part)
            if cap_m:
                after_cap = part[cap_m.start():]
                p_m = re.search(r'<p[^>]*>(.*?)</p>', after_cap, re.DOTALL)
                if p_m:
                    snippet_r = re.sub(r'<[^>]+>', "", p_m.group(1)).strip()
                    snippet_r = re.sub(r'&[a-z]+;', " ", snippet_r).strip()
            results.append({"title": title_r, "snippet": snippet_r, "url": url_r})
        return {"success": True, "results": results}
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