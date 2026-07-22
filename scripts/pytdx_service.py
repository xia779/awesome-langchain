# scripts/pytdx_service.py - pytdx 行情长驻服务（Flask, 默认 8085 端口）
# 直连通达信公开行情服务器，向 Node 侧 market-data.js 提供 REST 接口。
# 设计：服务器列表轮换 + 断线重连 + 全局锁（pytdx 非线程安全）。
# 启动：python scripts/pytdx_service.py [--port 8085]

import argparse
import threading
import time
import sys

from flask import Flask, request, jsonify

try:
    from pytdx.hq import TdxHq_API
except ImportError:
    print('pytdx 未安装，请先 pip install pytdx', file=sys.stderr)
    sys.exit(2)

try:
    from pytdx.config.hosts import hq_hosts as _HQ
    HQ_HOSTS = [(h[1], h[2]) for h in _HQ if len(h) >= 3]
except Exception:
    HQ_HOSTS = []

# 内置兜底服务器（hq_hosts 不可用时）
HQ_HOSTS += [
    ('119.147.212.81', 7709), ('112.74.214.43', 7709),
    ('59.173.18.69', 7709), ('218.75.126.9', 7709),
    ('101.227.73.20', 7709), ('14.215.128.18', 7709),
]
# 去重保序
_seen = set()
HQ_HOSTS = [h for h in HQ_HOSTS if not (h in _seen or _seen.add(h))]

KLINE_CATEGORY = {'1m': 7, '5m': 0, '15m': 1, '30m': 2, '1h': 3, 'day': 9, 'week': 5, 'month': 6}
MARKET_MAP = {'sh': 1, 'sz': 0}   # pytdx: 0=深圳 1=上海（北交所标准行情不支持）

app = Flask(__name__)
_lock = threading.Lock()
_state = {'api': None, 'server': None, 'idx': -1, 'since': 0}
_list_cache = {'ts': 0, 'data': None}


def _connect_next():
    """尝试下一个服务器，返回 True/False。"""
    for _ in range(len(HQ_HOSTS)):
        _state['idx'] = (_state['idx'] + 1) % len(HQ_HOSTS)
        ip, port = HQ_HOSTS[_state['idx']]
        try:
            api = TdxHq_API(heartbeat=True, auto_retry=True)
            ok = api.connect(ip, port, time_out=2)
            if ok:
                #  sanity 检查：能连上但返回空的是僵尸服务器，跳过
                rows = api.get_security_quotes([(1, '600519')])
                if not rows:
                    try:
                        api.disconnect()
                    except Exception:
                        pass
                    continue
                with _lock:
                    _state['api'] = api
                    _state['server'] = '%s:%s' % (ip, port)
                    _state['since'] = int(time.time())
                app.logger.info('connected %s:%s', ip, port)
                return True
        except Exception:
            continue
    return False


def _ensure():
    with _lock:
        if _state['api'] is not None:
            return True
    return _connect_next()


def _call(fn, retries=1):
    """带重连重试的行情调用。fn(api) -> result。失败抛异常。"""
    last_err = None
    for attempt in range(retries + 1):
        if not _ensure():
            last_err = RuntimeError('no available tdx server')
            continue
        try:
            with _lock:
                api = _state['api']
                result = fn(api)
            # 僵尸服务器：能连上但返回空，视为故障轮换下一台
            if result is None or (isinstance(result, list) and len(result) == 0):
                raise RuntimeError('empty result')
            return result
        except Exception as e:
            last_err = e
            with _lock:
                try:
                    if _state['api']:
                        _state['api'].disconnect()
                except Exception:
                    pass
                _state['api'] = None
    raise last_err


def _split_code(full):
    """sh600519 -> (1, '600519')；sz000001 -> (0, '000001')"""
    full = (full or '').strip().lower()
    if len(full) == 8 and full[:2] in MARKET_MAP and full[2:].isdigit():
        return MARKET_MAP[full[:2]], full[2:]
    return None, None


def _err(msg, code=400):
    return jsonify({'ok': False, 'error': msg}), code


@app.route('/health')
def health():
    ok = _ensure()
    return jsonify({'ok': ok, 'server': _state['server'], 'since': _state['since']})


@app.route('/quote')
def quote():
    codes = (request.args.get('codes') or '').split(',')
    pairs, invalid = [], []
    for c in codes:
        m, code = _split_code(c)
        if m is None:
            invalid.append(c)
        else:
            pairs.append((m, code))
    if not pairs:
        return _err('no valid codes, expect sh600519,sz000001')

    def fn(api):
        out = []
        for i in range(0, len(pairs), 60):
            batch = pairs[i:i + 60]
            rows = api.get_security_quotes(batch)
            if rows:
                out.extend(rows)
        return out

    try:
        rows = _call(fn)
    except Exception as e:
        return _err('quote failed: %s' % e, 503)
    data = []
    for r in rows:
        mkt = 'sh' if r.get('market') == 1 else 'sz'
        data.append({
            'code': mkt + str(r.get('code', '')),
            'price': r.get('price'), 'open': r.get('open'),
            'high': r.get('high'), 'low': r.get('low'),
            'prevClose': r.get('last_close'),
            'vol': r.get('vol'), 'amount': r.get('amount'),
        })
    return jsonify({'ok': True, 'server': _state['server'], 'invalid': invalid, 'data': data})


@app.route('/kline')
def kline():
    full = request.args.get('code') or ''
    period = request.args.get('period') or 'day'
    count = min(int(request.args.get('count') or 800), 3200)
    m, code = _split_code(full)
    if m is None:
        return _err('bad code: %s' % full)
    cat = KLINE_CATEGORY.get(period)
    if cat is None:
        return _err('bad period, expect one of %s' % ','.join(KLINE_CATEGORY))

    def fn(api):
        bars, start, remain = [], 0, count
        while remain > 0:
            n = min(remain, 800)
            page = api.get_security_bars(cat, m, code, start, n)
            if not page:
                break
            bars = page + bars          # page 为时间升序，向前翻页拼到前面
            start += len(page)
            remain -= len(page)
            if len(page) < n:
                break
        return bars

    try:
        bars = _call(fn)
    except Exception as e:
        return _err('kline failed: %s' % e, 503)
    data = [{
        'datetime': b.get('datetime'), 'open': b.get('open'), 'high': b.get('high'),
        'low': b.get('low'), 'close': b.get('close'), 'vol': b.get('vol'), 'amount': b.get('amount'),
    } for b in bars]
    return jsonify({'ok': True, 'data': data})


@app.route('/minute')
def minute():
    full = request.args.get('code') or ''
    m, code = _split_code(full)
    if m is None:
        return _err('bad code: %s' % full)
    try:
        rows = _call(lambda api: api.get_minute_time_data(m, code))
    except Exception as e:
        return _err('minute failed: %s' % e, 503)
    data = [{'price': r.get('price'), 'vol': r.get('vol')} for r in (rows or [])]
    return jsonify({'ok': True, 'data': data})


@app.route('/list')
def stock_list():
    now = time.time()
    if _list_cache['data'] is not None and now - _list_cache['ts'] < 3600:
        return jsonify({'ok': True, 'cached': True, 'data': _list_cache['data']})

    def fn(api):
        out = []
        for mkt, tag in ((1, 'sh'), (0, 'sz')):
            total = api.get_security_count(mkt) or 0
            for start in range(0, total, 1000):
                rows = api.get_security_list(mkt, start, 1000) or []
                for r in rows:
                    out.append({'code': tag + str(r.get('code', '')),
                                'name': r.get('name', ''),
                                'preClose': r.get('pre_close')})
        return out

    try:
        data = _call(fn)
    except Exception as e:
        return _err('list failed: %s' % e, 503)
    _list_cache['data'], _list_cache['ts'] = data, now
    return jsonify({'ok': True, 'cached': False, 'data': data})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8085)
    args = parser.parse_args()
    _connect_next()
    app.run(host='127.0.0.1', port=args.port, threaded=True, use_reloader=False)
