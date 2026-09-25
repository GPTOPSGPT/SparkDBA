"""Fault lab: reproducible PostgreSQL incidents with known ground truth.

Ported from the kb2026 KES chaos agent. Same four safety rules:
  1. self-terminating (every fault ends on its own after `duration`),
  2. only touches objects in the `lab` database owned by sparkdba_chaos,
  3. waiters carry statement_timeout as a backstop,
  4. cleanup restores the object state so runs are repeatable.

Sessions use neutral application names ("shop-api", "batch-job") on purpose:
the diagnosing agent must not be able to read the answer off a session name.
"""
import random
import threading
import time

import psycopg

from . import config

APP = "shop-api"

SETUP_SQL = """
create table if not exists orders(id serial primary key, customer_id int, amount numeric(10,2),
  status text, created_at timestamptz default now());
create table if not exists accounts(id int primary key, balance numeric(12,2));
create table if not exists events(id bigserial primary key, kind int, payload text);
create table if not exists order_items(id bigserial primary key, order_id int, sku int, qty int);
"""

SEED = [
    ("orders", "insert into orders(customer_id,amount,status) select (random()*5000)::int, "
               "round((random()*500)::numeric,2), (array['new','paid','shipped'])[1+(random()*2)::int] "
               "from generate_series(1,200000)"),
    ("accounts", "insert into accounts select g, 1000 from generate_series(1,10000) g"),
    ("events", "insert into events(kind,payload) select (random()*9)::int, md5(g::text) "
               "from generate_series(1,200000) g"),
    ("order_items", "insert into order_items(order_id,sku,qty) select (random()*200000)::int, "
                    "(random()*3000)::int, 1+(random()*4)::int from generate_series(1,2000000)"),
]

INDEX_SQL = "create index if not exists order_items_order_id_idx on order_items(order_id)"


def _conn(app=APP, autocommit=True):
    return psycopg.connect(config.CHAOS_DSN, application_name=app, autocommit=autocommit)


def setup():
    """Idempotent: create and seed lab tables."""
    with _conn("sparkdba-setup") as c:
        c.execute(SETUP_SQL)
        for table, sql in SEED:
            if c.execute(f"select count(*) from {table}").fetchone()[0] == 0:
                c.execute(sql)
                c.execute(f"analyze {table}")
        c.execute(INDEX_SQL)
    return {"ok": True}


# ── scenario bodies. Each gets (stop_event, params, log) and must return by itself ──

def _sleep(stop, sec):
    stop.wait(sec)


def _light_workload(stop, dur, log):
    """Background noise every scenario runs, so evidence is never a clean room."""
    end = time.time() + dur
    try:
        with _conn(APP) as c:
            while time.time() < end and not stop.is_set():
                c.execute("select amount from orders where id=%s", (random.randint(1, 200000),))
                c.execute("select balance from accounts where id=%s", (random.randint(1, 10000),))
                _sleep(stop, 0.2)
    except psycopg.Error as e:
        log(f"light workload ended: {e.__class__.__name__}")


def _lock_contention(stop, p, log):
    dur, n = p["duration"], p["waiters"]

    def holder():
        with _conn("batch-job", autocommit=False) as c:
            c.execute("lock table orders in access exclusive mode")
            log("holder took ACCESS EXCLUSIVE on orders")
            end = time.time() + dur
            while time.time() < end and not stop.is_set():   # a long batch, still holding the lock
                c.execute("select pg_sleep(2)")
            c.rollback()

    def waiter(i):
        try:
            with _conn(APP) as c:
                c.execute(f"set statement_timeout = '{dur + 20}s'")
                note = f" /* {p['note']} */" if p.get("note") else ""
                c.execute(f"select count(*) from orders where status='paid'{note}")
        except psycopg.Error:
            pass

    return [holder] + [lambda i=i: waiter(i) for i in range(n)]


def _idle_in_transaction(stop, p, log):
    dur, n = p["duration"], p["waiters"]

    def holder():
        with _conn(APP, autocommit=False) as c:
            c.execute("update accounts set balance = balance + 1 where id = 42")
            log("holder updated accounts.id=42 and went idle without commit")
            _sleep(stop, dur)      # idle in transaction: no statement running
            c.rollback()

    def waiter(i):
        time.sleep(1)
        try:
            with _conn(APP) as c:
                c.execute(f"set statement_timeout = '{dur + 20}s'")
                c.execute("update accounts set balance = balance - 1 where id = 42")
        except psycopg.Error:
            pass

    return [holder] + [lambda i=i: waiter(i) for i in range(n)]


def _table_bloat(stop, p, log):
    dur, rounds = p["duration"], p["rounds"]

    def body():
        with _conn("batch-job") as c:
            c.execute("alter table events set (autovacuum_enabled = false)")
            for r in range(rounds):
                if stop.is_set():
                    return
                c.execute("update events set payload = md5(random()::text)")
            log(f"rewrote events {rounds}x with autovacuum disabled on that table")
        end = time.time() + dur
        with _conn(APP) as c:   # readers now scan a table full of dead tuples
            while time.time() < end and not stop.is_set():
                c.execute("select count(*) from events where kind = 3")
                _sleep(stop, 0.5)

    return [body]


def _connection_storm(stop, p, log):
    dur, want = p["duration"], p["conns"]
    with _conn("sparkdba-setup") as c:
        mx = int(c.execute("show max_connections").fetchone()[0])
        used = c.execute("select count(*) from pg_stat_activity").fetchone()[0]
    n = max(0, min(want, mx - used - 15))    # always leave 15 slots for operators
    if n < want:
        log(f"capped connections {want} -> {n} (max_connections={mx}, in use={used}, reserve=15)")

    def body():
        conns = []
        try:
            for _ in range(n):
                if stop.is_set():
                    break
                conns.append(_conn(APP))
            log(f"opened {len(conns)} idle connections")
            _sleep(stop, dur)
        finally:
            for c in conns:
                c.close()

    return [body]


def _missing_index(stop, p, log):
    dur, n = p["duration"], p["workers"]

    def prep():
        with _conn("sparkdba-setup") as c:
            c.execute("drop index if exists order_items_order_id_idx")
        log("dropped index order_items_order_id_idx")

    prep()

    def worker(i):
        end = time.time() + dur
        with _conn(APP) as c:
            while time.time() < end and not stop.is_set():
                c.execute("select sum(qty) from order_items where order_id = %s",
                          (random.randint(1, 200000),))

    return [lambda i=i: worker(i) for i in range(n)]


def _healthy(stop, p, log):
    log("control run: light workload only, no fault")
    return []


def _cleanup(sid):
    with _conn("sparkdba-setup") as c:
        if sid == "table_bloat":
            c.execute("alter table events reset (autovacuum_enabled)")
            c.execute("vacuum analyze events")
        if sid == "missing_index":
            c.execute(INDEX_SQL)


SCENARIOS = [
    {"id": "lock_contention", "name": "锁竞争（表级阻塞）", "en": "Lock contention",
     "desc": "A batch job holds ACCESS EXCLUSIVE on orders; API sessions queue behind it.",
     "desc_zh": "批处理作业持有 orders 表的 ACCESS EXCLUSIVE 锁，API 会话在其后排队。",
     "params": {"duration": 150, "waiters": 3, "note": ""}, "warmup": 8, "build": _lock_contention},
    {"id": "idle_in_transaction", "name": "长事务未提交（隐形持锁）", "en": "Idle in transaction",
     "desc": "A session updates a row and goes idle without committing; writers to that row wait.",
     "desc_zh": "一个会话更新了一行后空闲且不提交，写这一行的会话都在等待。",
     "params": {"duration": 150, "waiters": 3}, "warmup": 8, "build": _idle_in_transaction},
    {"id": "table_bloat", "name": "表膨胀（死元组堆积）", "en": "Table bloat",
     "desc": "Full-table rewrites with autovacuum off for that table; readers scan dead tuples.",
     "desc_zh": "该表关闭 autovacuum 后反复整表改写，读请求要扫过大量死元组。",
     "params": {"duration": 150, "rounds": 4}, "warmup": 25, "build": _table_bloat},
    {"id": "connection_storm", "name": "连接堆积（无连接池）", "en": "Connection storm",
     "desc": "Many connections opened and left idle, the fingerprint of an app without a pool.",
     "desc_zh": "大量连接打开后闲置，是应用没有连接池的典型特征。",
     "params": {"duration": 150, "conns": 120}, "warmup": 8, "build": _connection_storm},
    {"id": "missing_index", "name": "缺失索引（全表扫描）", "en": "Missing index",
     "desc": "The index behind a hot lookup is gone; every lookup scans 2M rows.",
     "desc_zh": "热点查询依赖的索引被删除，每次查询都扫描 200 万行。",
     "params": {"duration": 150, "workers": 4}, "warmup": 15, "build": _missing_index},
    {"id": "healthy", "name": "健康对照（无故障）", "en": "Healthy control",
     "desc": "No fault. Tests that the agent does not invent a problem.",
     "desc_zh": "没有故障。检验智能体不会凭空编造问题。",
     "params": {"duration": 150}, "warmup": 8, "build": _healthy},
]
BY_ID = {s["id"]: s for s in SCENARIOS}

# ponytail: one active scenario at a time, process-global; the lab is a single database.
_state = {"run": None}
_lock = threading.Lock()


def public():
    return [{k: v for k, v in s.items() if k != "build"} for s in SCENARIOS]


def _reset_stats():
    with _conn("sparkdba-setup") as c:
        c.execute("select pg_stat_reset()")
        c.execute("select pg_stat_statements_reset()")


def start(sid: str, params: dict | None = None) -> dict:
    s = BY_ID.get(sid)
    if not s:
        return {"ok": False, "error": f"unknown scenario {sid}"}
    with _lock:
        cur = _state["run"]
        if cur and not cur["done"]:
            return {"ok": False, "error": f"scenario {cur['id']} still running"}
        p = {**s["params"], **{k: (int(v) if isinstance(s["params"][k], int) else str(v).replace("*/", "")[:300])
                               for k, v in (params or {}).items() if k in s["params"]}}
        p["duration"] = max(30, min(p["duration"], 600))
        stop = threading.Event()
        run = {"id": sid, "params": p, "started": time.time(), "ready_at": time.time() + s["warmup"],
               "log": [], "done": False, "stop": stop}

        def log(msg):
            run["log"].append(f"{time.strftime('%H:%M:%S')} {msg}")

        _reset_stats()
        bodies = s["build"](stop, p, log) + [lambda: _light_workload(stop, p["duration"], log)]
        threads = [threading.Thread(target=b, daemon=True) for b in bodies]
        for t in threads:
            t.start()

        def reaper():
            for t in threads:
                t.join(p["duration"] + 60)
            try:
                _cleanup(sid)
                log("cleanup done")
            except psycopg.Error as e:
                log(f"cleanup error: {e}")
            run["done"] = True

        threading.Thread(target=reaper, daemon=True).start()
        _state["run"] = run
        log(f"started {sid} {p}")
        return {"ok": True, **status()}


def stop() -> dict:
    run = _state["run"]
    if run and not run["done"]:
        run["stop"].set()
    return status()


def status() -> dict:
    run = _state["run"]
    if not run:
        return {"active": None}
    now = time.time()
    return {"active": run["id"], "params": run["params"], "done": run["done"],
            "ready": now >= run["ready_at"], "elapsed": int(now - run["started"]),
            "log": run["log"][-20:]}


def wait_ready(timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        st = status()
        if st.get("ready") or st.get("done"):
            return st
        time.sleep(1)
    return status()
