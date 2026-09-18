"""
╔══════════════════════════════════════════════════════════════════════╗
║        BOT PHÂN TÍCH XÚC XẮC MD5 - BoKietvidai v4.0                ║
║  Flask (Main Thread) + Telegram Bot (Daemon Thread) → Deploy Render  ║
╚══════════════════════════════════════════════════════════════════════╝

Kiến trúc:
  Gunicorn (1 worker)
    ├── Main Thread  → Flask HTTP Server (Health Check Render)
    └── Daemon Thread → Telegram Bot (asyncio event loop riêng)
"""

# ══════════════════════════════════════════════════════════════════════
# §0  CẤU HÌNH
# ══════════════════════════════════════════════════════════════════════
BOT_TOKEN : str = "8931512528:AAE9CC1Kw_xRFO6QYJkQI6Su60dA7I0cDlQ"
ADMIN_ID  : int = 8284419367

# ══════════════════════════════════════════════════════════════════════
# §1  IMPORT
# ══════════════════════════════════════════════════════════════════════
import asyncio
import hashlib
import logging
import math
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

import nest_asyncio
from flask import Flask

from telegram import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Update,
)
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters,
)

# ══════════════════════════════════════════════════════════════════════
# §2  LOGGING
# ══════════════════════════════════════════════════════════════════════
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("BoKiet")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)
logging.getLogger("apscheduler").setLevel(logging.WARNING)

# ══════════════════════════════════════════════════════════════════════
# §3  FLASK — Main Thread, Render Health Check
# ══════════════════════════════════════════════════════════════════════
app = Flask(__name__)

@app.route("/")
def root():
    return "OK", 200

@app.route("/health")
def health():
    return "OK", 200

# ══════════════════════════════════════════════════════════════════════
# §4  DATABASE — SQLite + threading.Lock
# ══════════════════════════════════════════════════════════════════════
DB   = "bokiet.db"
_DL  = threading.Lock()   # DB write lock


def _conn() -> sqlite3.Connection:
    return sqlite3.connect(DB, check_same_thread=False)


def db_init() -> None:
    with _DL, _conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS keys (
                code            TEXT PRIMARY KEY,
                label           TEXT NOT NULL,
                expires_at      REAL,
                used_by         INTEGER,
                used_at         REAL,
                created_at      REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                uid             INTEGER PRIMARY KEY,
                key_code        TEXT,
                key_expires     REAL
            );
            CREATE TABLE IF NOT EXISTS feedback (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                uid             INTEGER NOT NULL,
                md5             TEXT NOT NULL,
                prediction      TEXT NOT NULL,
                correct         INTEGER NOT NULL,
                ts_seed         TEXT NOT NULL,
                at              REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bias (
                bucket          TEXT PRIMARY KEY,
                score           REAL NOT NULL DEFAULT 0.0,
                total           INTEGER NOT NULL DEFAULT 0
            );
        """)
        c.commit()
    log.info("✅ DB ready: %s", DB)


# ─── Key helpers ──────────────────────────────────────────────────────

_LABEL_DELTA: dict[str, Optional[timedelta]] = {
    "1 ngày":    timedelta(days=1),
    "3 ngày":    timedelta(days=3),
    "7 ngày":    timedelta(days=7),
    "1 tháng":   timedelta(days=30),
    "1 năm":     timedelta(days=365),
    "Vĩnh viễn": None,
}


def _expire_ts(label: str) -> Optional[float]:
    """Tính expiry Unix-ts bắt đầu từ NOW."""
    delta = _LABEL_DELTA.get(label)
    return None if delta is None else (datetime.now(timezone.utc) + delta).timestamp()


def key_create(label: str) -> str:
    code = f"BoKietvidai-{secrets.token_hex(8).upper()}"
    with _DL, _conn() as c:
        c.execute(
            "INSERT INTO keys(code,label,created_at) VALUES(?,?,?)",
            (code, label, time.time()),
        )
        c.commit()
    return code


def key_activate(code: str, uid: int) -> dict:
    with _DL, _conn() as c:
        row = c.execute(
            "SELECT label,expires_at,used_by FROM keys WHERE code=?", (code,)
        ).fetchone()
        if not row:
            return {"ok": False, "msg": "❌ Key không tồn tại!"}
        label, exp_at, used_by = row
        if used_by is not None and used_by != uid:
            return {"ok": False, "msg": "❌ Key này đã được người khác sử dụng!"}
        if exp_at is not None and time.time() > exp_at:
            return {"ok": False, "msg": "⏰ Key đã hết hạn!"}
        now = time.time()
        if used_by is None:          # lần kích hoạt đầu → tính expires từ bây giờ
            exp_at = _expire_ts(label)
            c.execute(
                "UPDATE keys SET used_by=?,used_at=?,expires_at=? WHERE code=?",
                (uid, now, exp_at, code),
            )
        c.execute(
            "INSERT OR REPLACE INTO users(uid,key_code,key_expires) VALUES(?,?,?)",
            (uid, code, exp_at),
        )
        c.commit()
    return {"ok": True, "expires_at": exp_at}


def user_access(uid: int) -> dict:
    if uid == ADMIN_ID:
        return {"ok": True}
    with _conn() as c:
        row = c.execute("SELECT key_code,key_expires FROM users WHERE uid=?", (uid,)).fetchone()
    if not row or not row[0]:
        return {"ok": False, "why": "no_key"}
    if row[1] is not None and time.time() > row[1]:
        return {"ok": False, "why": "expired"}
    return {"ok": True, "expires_at": row[1]}


def user_key_info(uid: int) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT key_code,key_expires FROM users WHERE uid=?", (uid,)).fetchone()
    return {"code": row[0], "expires_at": row[1]} if row else None


# ─── Feedback / Bias helpers ──────────────────────────────────────────

def _bucket(md5: str) -> str:
    return md5[:2].lower()


def feedback_save(uid: int, md5: str, pred: str, correct: bool, ts: str) -> None:
    sign = 1.0 if correct else -1.0
    with _DL, _conn() as c:
        c.execute(
            "INSERT INTO feedback(uid,md5,prediction,correct,ts_seed,at) VALUES(?,?,?,?,?,?)",
            (uid, md5, pred, int(correct), ts, time.time()),
        )
        c.execute(
            """INSERT INTO bias(bucket,score,total) VALUES(?,?,1)
               ON CONFLICT(bucket) DO UPDATE SET score=score+?,total=total+1""",
            (_bucket(md5), sign, sign),
        )
        c.commit()


def bias_get(md5: str) -> float:
    with _conn() as c:
        row = c.execute(
            "SELECT score,total FROM bias WHERE bucket=?", (_bucket(md5),)
        ).fetchone()
    if not row or row[1] == 0:
        return 0.0
    return max(-1.0, min(1.0, row[0] / row[1]))

# ══════════════════════════════════════════════════════════════════════
# §5  THUẬT TOÁN LÕI
# ══════════════════════════════════════════════════════════════════════

def _entropy(data: bytes) -> float:
    if not data:
        return 0.0
    cnt = Counter(data)
    n   = len(data)
    return -sum((v / n) * math.log2(v / n) for v in cnt.values())


def _bit_ratio(data: bytes) -> float:
    """Tỷ lệ bit-1 trên toàn bộ seed bytes (0.0 – 1.0)."""
    total = len(data) * 8
    ones  = sum(bin(b).count("1") for b in data)
    return ones / total if total else 0.5


def analyze(md5_hex: str) -> dict:
    """
    5-layer analysis:
      L1  Seed = md5 + timestamp(giây) → SHA-256 → 32 bytes
      L2  10× dice simulation (mod 6, 3 con xúc xắc / lượt)
      L3  Shannon Entropy (độ ngẫu nhiên seed)
      L4  Bitwise ratio (xu hướng bit)
      L5  Adaptive bias từ lịch sử phản hồi người dùng
    """
    # ── L1: Seed ──────────────────────────────────────────────────────
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")   # cố định trong 1 giây
    raw  = f"{md5_hex.lower()}|{ts}"
    seed = hashlib.sha256(raw.encode()).digest()            # 32 bytes

    # ── L2: Xúc xắc ──────────────────────────────────────────────────
    xoai = tao = 0
    for i in range(0, 30, 3):
        total_dice = ((seed[i] % 6) + 1 +
                      (seed[i+1] % 6) + 1 +
                      (seed[i+2] % 6) + 1)
        if total_dice <= 10:
            xoai += 1
        else:
            tao  += 1

    # ── L3: Entropy ───────────────────────────────────────────────────
    ent = _entropy(seed)                    # 0 – 8 bits

    # ── L4: Bitwise ratio ─────────────────────────────────────────────
    br  = _bit_ratio(seed)                  # 0 – 1
    # br > 0.5  → ủng hộ TÁO; < 0.5 → ủng hộ XOÀI
    # chuyển sang tín hiệu [0,1] đại diện cho xác suất XOÀI
    bit_signal = 1.0 - br                   # cao → thiên XOÀI

    # ── Kết hợp (weighted) ────────────────────────────────────────────
    dice_signal = xoai / 10.0              # 80 % trọng số
    combined    = 0.80 * dice_signal + 0.20 * bit_signal

    # ── L5: Adaptive bias (±5 %) ──────────────────────────────────────
    bias     = bias_get(md5_hex)           # -1 → +1
    combined = max(0.0, min(1.0, combined + 0.05 * bias))

    # ── Quyết định ────────────────────────────────────────────────────
    if combined > 0.5:
        pred = "🍊 XOÀI"
        conf = round(combined * 100, 2)
    elif combined < 0.5:
        pred = "🍎 TÁO"
        conf = round((1.0 - combined) * 100, 2)
    else:                                  # tie-breaker
        pred = "🍊 XOÀI" if seed[31] % 2 == 0 else "🍎 TÁO"
        conf = 50.0

    return {
        "pred":       pred,
        "conf":       conf,
        "entropy":    round(ent, 4),
        "bit_pct":    round(br * 100, 2),
        "bias_pct":   round(bias * 100, 2),
        "xoai":       xoai,
        "tao":        tao,
        "ts":         ts,
        "seed_hex":   seed.hex()[:12] + "...",
    }

# ══════════════════════════════════════════════════════════════════════
# §6  CONVERSATION STATES & IN-MEMORY CONTEXT
# ══════════════════════════════════════════════════════════════════════
S_MD5  = 1
S_KEY  = 2
S_TIER = 3

# Lưu context phản hồi: key = "uid:msg_id"
_pfb: dict[str, dict] = {}
_pfl = threading.Lock()


def _pfb_put(uid: int, mid: int, md5: str, pred: str, ts: str) -> None:
    with _pfl:
        _pfb[f"{uid}:{mid}"] = {"md5": md5, "pred": pred, "ts": ts}


def _pfb_pop(uid: int, mid: int) -> Optional[dict]:
    with _pfl:
        return _pfb.pop(f"{uid}:{mid}", None)

# ══════════════════════════════════════════════════════════════════════
# §7  KEYBOARDS & HELPERS
# ══════════════════════════════════════════════════════════════════════

def kb_main(uid: int) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton("🔍 [1] Phân tích MD5", callback_data="m:analyze")],
        [InlineKeyboardButton("🔑 [2] Nhập Key",       callback_data="m:enterkey")],
    ]
    if uid == ADMIN_ID:
        rows.append([InlineKeyboardButton("⚙️ [3] Tạo Key  ·  Admin", callback_data="m:createkey")])
    return InlineKeyboardMarkup(rows)


def kb_tier() -> InlineKeyboardMarkup:
    opts = [
        ("1️⃣  1 ngày",    "t:1d"),
        ("2️⃣  3 ngày",    "t:3d"),
        ("3️⃣  7 ngày",    "t:7d"),
        ("4️⃣  1 tháng",   "t:1m"),
        ("5️⃣  1 năm",     "t:1y"),
        ("6️⃣  Vĩnh viễn", "t:inf"),
    ]
    rows = [[InlineKeyboardButton(lbl, callback_data=cb)] for lbl, cb in opts]
    rows.append([InlineKeyboardButton("🔙 Quay lại", callback_data="m:back")])
    return InlineKeyboardMarkup(rows)


def kb_feedback(uid: int, mid: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("✅ ĐÚNG", callback_data=f"fb:ok:{uid}:{mid}"),
        InlineKeyboardButton("❌ SAI",  callback_data=f"fb:no:{uid}:{mid}"),
    ]])


TIER_MAP = {
    "t:1d": "1 ngày", "t:3d": "3 ngày", "t:7d": "7 ngày",
    "t:1m": "1 tháng", "t:1y": "1 năm",  "t:inf": "Vĩnh viễn",
}

MD5_RE = re.compile(r"^[0-9a-fA-F]{32}$")
KEY_RE = re.compile(r"^BoKietvidai-[0-9A-Fa-f]{16}$")


def fmt_exp(ts: Optional[float]) -> str:
    if ts is None:
        return "♾️ Vĩnh viễn"
    return datetime.fromtimestamp(ts).strftime("%d/%m/%Y %H:%M:%S")


def bar(pct: float, w: int = 18) -> str:
    f = int(pct / 100 * w)
    return "█" * f + "░" * (w - f)


# MarkdownV2 escape
_ESC_CHARS = r"\_*[]()~`>#+-=|{}.!"
def esc(t: str) -> str:
    for ch in _ESC_CHARS:
        t = t.replace(ch, f"\\{ch}")
    return t


WELCOME = (
    "👋 *Chào mừng đến với BoKiet Dice Bot\\!*\n\n"
    "🎲 Phân tích & dự đoán Xúc xắc qua chuỗi MD5\n\n"
    "🍊 *XOÀI* → Tổng 3 xúc xắc: 3–10 điểm\n"
    "🍎 *TÁO*  → Tổng 3 xúc xắc: 11–18 điểm\n\n"
    "👇 *Chọn chức năng:*"
)

# ══════════════════════════════════════════════════════════════════════
# §8  TELEGRAM HANDLERS
# ══════════════════════════════════════════════════════════════════════

async def h_start(u: Update, _: ContextTypes.DEFAULT_TYPE) -> int:
    if u.effective_chat.type != "private":
        return ConversationHandler.END
    await u.message.reply_text(
        WELCOME, parse_mode=ParseMode.MARKDOWN_V2,
        reply_markup=kb_main(u.effective_user.id),
    )
    return ConversationHandler.END


# ─── Menu callbacks ───────────────────────────────────────────────────

async def cb_analyze(u: Update, _: ContextTypes.DEFAULT_TYPE) -> int:
    q = u.callback_query; await q.answer()
    uid = q.from_user.id
    acc = user_access(uid)
    if not acc["ok"]:
        note = ("🔒 Bạn chưa kích hoạt Key\\!\nChọn \\[2\\] Nhập Key trước\\."
                if acc["why"] == "no_key"
                else "⏰ Key đã hết hạn\\! Vui lòng nhập Key mới\\.")
        await q.edit_message_text(note, parse_mode=ParseMode.MARKDOWN_V2,
                                  reply_markup=kb_main(uid))
        return ConversationHandler.END

    extra = ""
    if uid != ADMIN_ID:
        info = user_key_info(uid)
        if info:
            extra = f"\n⏳ Hết hạn: `{esc(fmt_exp(info['expires_at']))}`\n"

    await q.edit_message_text(
        f"🔍 *Phân tích MD5*{extra}\n\n"
        "📋 Gửi chuỗi MD5 \\(32 ký tự hex\\):\n"
        "_Ví dụ: `d41d8cd98f00b204e9800998ecf8427e`_",
        parse_mode=ParseMode.MARKDOWN_V2,
    )
    return S_MD5


async def cb_enterkey(u: Update, _: ContextTypes.DEFAULT_TYPE) -> int:
    q = u.callback_query; await q.answer()
    await q.edit_message_text(
        "🔑 *Nhập Key kích hoạt*\n\n"
        "Dán chuỗi Key vào đây:\n"
        "_Định dạng: `BoKietvidai\\-XXXXXXXXXXXXXXXX`_",
        parse_mode=ParseMode.MARKDOWN_V2,
    )
    return S_KEY


async def cb_createkey(u: Update, _: ContextTypes.DEFAULT_TYPE) -> int:
    q = u.callback_query; await q.answer()
    if q.from_user.id != ADMIN_ID:
        await q.edit_message_text("🚫 Không có quyền truy cập\\!",
                                  parse_mode=ParseMode.MARKDOWN_V2,
                                  reply_markup=kb_main(q.from_user.id))
        return ConversationHandler.END
    await q.edit_message_text(
        "⚙️ *Tạo Key mới*\n\nChọn thời hạn:",
        parse_mode=ParseMode.MARKDOWN_V2, reply_markup=kb_tier(),
    )
    return S_TIER


async def cb_back(u: Update, _: ContextTypes.DEFAULT_TYPE) -> int:
    q = u.callback_query; await q.answer()
    await q.edit_message_text(
        WELCOME, parse_mode=ParseMode.MARKDOWN_V2,
        reply_markup=kb_main(q.from_user.id),
    )
    return ConversationHandler.END


async def cb_tier(u: Update, _: ContextTypes.DEFAULT_TYPE) -> int:
    q = u.callback_query; await q.answer()
    if q.from_user.id != ADMIN_ID:
        await q.edit_message_text("🚫 Không có quyền\\!",
                                  parse_mode=ParseMode.MARKDOWN_V2)
        return ConversationHandler.END

    label = TIER_MAP[q.data]
    code  = key_create(label)
    exp_note = (
        f"`{esc(label)}` \\(tính từ lúc User kích hoạt\\)"
        if label != "Vĩnh viễn" else "♾️ Vĩnh viễn"
    )
    await q.edit_message_text(
        f"✅ *Key đã tạo thành công\\!*\n\n"
        f"🔑 Key:\n`{esc(code)}`\n\n"
        f"⏳ Thời hạn: {exp_note}\n\n"
        f"📋 _Copy key trên và gửi cho người dùng\\._",
        parse_mode=ParseMode.MARKDOWN_V2,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("➕ Tạo Key khác", callback_data="m:createkey")],
            [InlineKeyboardButton("🏠 Menu chính",   callback_data="m:back")],
        ]),
    )
    return ConversationHandler.END


# ─── Nhận MD5 ─────────────────────────────────────────────────────────

async def h_md5(u: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    uid  = u.effective_user.id
    text = (u.message.text or "").strip()

    if not MD5_RE.match(text):
        await u.message.reply_text(
            "⚠️ *MD5 không hợp lệ\\!*\n\n"
            "Cần đúng *32 ký tự Hex* \\(0\\-9, a\\-f\\)\\. Gửi lại:",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return S_MD5  # giữ state, chờ nhập lại

    acc = user_access(uid)
    if not acc["ok"]:
        await u.message.reply_text(
            "⏰ Key vừa hết hạn\\! Vui lòng nhập Key mới\\.",
            parse_mode=ParseMode.MARKDOWN_V2, reply_markup=kb_main(uid),
        )
        return ConversationHandler.END

    proc = await u.message.reply_text("⏳ Đang phân tích\\.\\.\\.",
                                      parse_mode=ParseMode.MARKDOWN_V2)
    r = analyze(text)

    bias_sign = "\\+" if r["bias_pct"] >= 0 else ""
    emoji     = "🍊" if "XOÀI" in r["pred"] else "🍎"
    progress  = bar(r["conf"])

    body = (
        "━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "🎲 *KẾT QUẢ PHÂN TÍCH XÚC XẮC*\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📥 MD5 : `{esc(text.lower())}`\n"
        f"⏱ Seed : `{esc(r['ts'])}`\n"
        f"🔐 Hash : `{esc(r['seed_hex'])}`\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{emoji} *DỰ ĐOÁN:  {esc(r['pred'])}*\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📊 Độ tin cậy:\n"
        f"`\\[{esc(progress)}\\]`  *{r['conf']}%*\n\n"
        f"📈 Shannon Entropy : `{r['entropy']} bits`\n"
        f"⚡ Bitwise Score   : `{r['bit_pct']}%`\n"
        f"🧠 Adaptive Bias   : `{bias_sign}{r['bias_pct']}%`\n\n"
        f"🍊 Mẫu XOÀI \\(3–10\\) : `{r['xoai']}/10`\n"
        f"🍎 Mẫu TÁO  \\(11–18\\): `{r['tao']}/10`\n\n"
        "👇 *Kết quả có đúng không\\?*"
    )

    await proc.delete()
    await u.message.reply_text(
        body,
        parse_mode=ParseMode.MARKDOWN_V2,
        reply_markup=kb_feedback(uid, u.message.message_id),
    )
    # Lưu context phản hồi (key = uid + message_id của tin người dùng gửi)
    _pfb_put(uid, u.message.message_id, text.lower(), r["pred"], r["ts"])
    return ConversationHandler.END


# ─── Nhận Key ─────────────────────────────────────────────────────────

async def h_key(u: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    uid  = u.effective_user.id
    text = (u.message.text or "").strip()

    if not KEY_RE.match(text):
        await u.message.reply_text(
            "⚠️ *Định dạng Key không đúng\\!*\n\n"
            "Key phải có dạng:\n`BoKietvidai\\-XXXXXXXXXXXXXXXX`\n\nGửi lại:",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return S_KEY

    res = key_activate(text, uid)
    if res["ok"]:
        exp_str = fmt_exp(res.get("expires_at"))
        await u.message.reply_text(
            f"✅ *Kích hoạt thành công\\!*\n\n"
            f"🔑 Key    : `{esc(text)}`\n"
            f"⏳ Hết hạn: `{esc(exp_str)}`\n\n"
            f"🎉 Bạn có thể dùng *Phân tích MD5* ngay\\!",
            parse_mode=ParseMode.MARKDOWN_V2, reply_markup=kb_main(uid),
        )
        await _notify_admin(ctx, u.effective_user, text, exp_str)
    else:
        await u.message.reply_text(
            f"{esc(res['msg'])}\n\nLiên hệ Admin để được hỗ trợ\\.",
            parse_mode=ParseMode.MARKDOWN_V2, reply_markup=kb_main(uid),
        )
    return ConversationHandler.END


# ─── Feedback callback ────────────────────────────────────────────────

async def cb_feedback(u: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    q   = u.callback_query
    uid = q.from_user.id
    await q.answer()

    # Pattern: fb:ok:{uid}:{mid}  hoặc  fb:no:{uid}:{mid}
    parts = q.data.split(":")
    if len(parts) != 4:
        return

    _, verdict, owner_str, mid_str = parts
    owner = int(owner_str)
    mid   = int(mid_str)

    if uid != owner:
        await q.answer("🚫 Đây không phải phiên của bạn!", show_alert=True)
        return

    ctx_data = _pfb_pop(uid, mid)
    if ctx_data is None:
        await q.edit_message_reply_markup(reply_markup=None)
        return

    correct = (verdict == "ok")
    feedback_save(uid, ctx_data["md5"], ctx_data["pred"], correct, ctx_data["ts"])

    icon = "✅" if correct else "❌"
    note = "ĐÚNG — Cảm ơn bạn đã xác nhận\\!" if correct else "SAI — Hệ thống đã học từ phản hồi\\!"

    old = q.message.text or ""
    # Cắt dòng cuối "👇 ..."
    trimmed = old.rsplit("👇", 1)[0].strip()

    await q.edit_message_text(
        trimmed + f"\n\n{icon} *Phản hồi:* {note}",
        parse_mode=ParseMode.MARKDOWN_V2,
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("🔄 Phân tích tiếp", callback_data="m:analyze"),
            InlineKeyboardButton("🏠 Menu",            callback_data="m:back"),
        ]]),
    )


# ─── Admin notify ─────────────────────────────────────────────────────

async def _notify_admin(ctx: ContextTypes.DEFAULT_TYPE, user, code: str, exp: str) -> None:
    try:
        uname = f"@{esc(user.username)}" if user.username else "_\\(không có username\\)_"
        await ctx.bot.send_message(
            chat_id=ADMIN_ID,
            text=(
                "🔔 *Thông báo kích hoạt Key*\n\n"
                f"👤 User    : {esc(user.full_name)} \\({uname}\\)\n"
                f"🆔 ID      : `{user.id}`\n"
                f"🔑 Key     : `{esc(code)}`\n"
                f"⏳ Hết hạn : `{esc(exp)}`\n"
                f"🕐 Lúc     : `{esc(datetime.now().strftime('%d/%m/%Y %H:%M:%S'))}`"
            ),
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        log.warning("Không gửi được thông báo Admin: %s", e)


# ─── Lệnh /admin ──────────────────────────────────────────────────────

async def h_admin(u: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    if u.effective_user.id != ADMIN_ID:
        await u.message.reply_text("🚫 Không có quyền\\!", parse_mode=ParseMode.MARKDOWN_V2)
        return
    with _conn() as c:
        tk = c.execute("SELECT COUNT(*) FROM keys").fetchone()[0]
        ak = c.execute("SELECT COUNT(*) FROM keys WHERE used_by IS NOT NULL").fetchone()[0]
        tu = c.execute("SELECT COUNT(*) FROM users WHERE key_code IS NOT NULL").fetchone()[0]
        au = c.execute(
            "SELECT COUNT(*) FROM users WHERE key_code IS NOT NULL"
            " AND (key_expires IS NULL OR key_expires>?)", (time.time(),)
        ).fetchone()[0]
        tf = c.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        cf = c.execute("SELECT COUNT(*) FROM feedback WHERE correct=1").fetchone()[0]
    acc = round(cf / tf * 100, 1) if tf else 0.0
    await u.message.reply_text(
        "📊 *Thống kê hệ thống*\n\n"
        f"🔑 Tổng Key tạo      : `{tk}`\n"
        f"✅ Key đã kích hoạt  : `{ak}`\n"
        f"👥 Tổng User có Key  : `{tu}`\n"
        f"🟢 User đang hợp lệ  : `{au}`\n\n"
        f"📈 Tổng phản hồi     : `{tf}`\n"
        f"🎯 Tỷ lệ đúng        : `{acc}%`\n\n"
        f"🕐 `{esc(datetime.now().strftime('%d/%m/%Y %H:%M:%S'))}`",
        parse_mode=ParseMode.MARKDOWN_V2, reply_markup=kb_main(ADMIN_ID),
    )


# ─── Tin nhắn bất kỳ ──────────────────────────────────────────────────

async def h_unknown(u: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    if u.effective_chat and u.effective_chat.type == "private":
        await u.message.reply_text(
            "Dùng /start để mở menu\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
            reply_markup=kb_main(u.effective_user.id),
        )

# ══════════════════════════════════════════════════════════════════════
# §9  BUILD TELEGRAM APPLICATION
# ══════════════════════════════════════════════════════════════════════

def _build_tg() -> Application:
    tg = Application.builder().token(BOT_TOKEN).build()

    conv = ConversationHandler(
        entry_points=[
            CommandHandler("start",    h_start),
            CallbackQueryHandler(cb_analyze,   pattern=r"^m:analyze$"),
            CallbackQueryHandler(cb_enterkey,  pattern=r"^m:enterkey$"),
            CallbackQueryHandler(cb_createkey, pattern=r"^m:createkey$"),
            CallbackQueryHandler(cb_back,      pattern=r"^m:back$"),
            CallbackQueryHandler(cb_tier,      pattern=r"^t:"),
        ],
        states={
            S_MD5: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, h_md5),
                CallbackQueryHandler(cb_analyze,   pattern=r"^m:analyze$"),
                CallbackQueryHandler(cb_enterkey,  pattern=r"^m:enterkey$"),
                CallbackQueryHandler(cb_createkey, pattern=r"^m:createkey$"),
                CallbackQueryHandler(cb_back,      pattern=r"^m:back$"),
            ],
            S_KEY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, h_key),
                CallbackQueryHandler(cb_back, pattern=r"^m:back$"),
            ],
            S_TIER: [
                CallbackQueryHandler(cb_tier, pattern=r"^t:"),
                CallbackQueryHandler(cb_back, pattern=r"^m:back$"),
            ],
        },
        fallbacks=[
            CommandHandler("start", h_start),
            CommandHandler("admin", h_admin),
        ],
        per_message=False,
    )

    tg.add_handler(conv)
    tg.add_handler(CallbackQueryHandler(cb_feedback, pattern=r"^fb:"))
    tg.add_handler(CommandHandler("admin", h_admin))
    tg.add_handler(
        MessageHandler(filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE, h_unknown)
    )
    return tg


# ══════════════════════════════════════════════════════════════════════
# §10  DAEMON THREAD — chạy Bot Telegram
# ══════════════════════════════════════════════════════════════════════

def _bot_thread_fn() -> None:
    """
    Chạy trong Daemon Thread riêng biệt.
    nest_asyncio.apply() + new_event_loop() tránh xung đột với Flask/Gunicorn.
    """
    nest_asyncio.apply()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    tg = _build_tg()

    async def _run():
        await tg.bot.set_my_commands([
            BotCommand("start", "Mở menu chính"),
            BotCommand("admin", "Thống kê (Admin)"),
        ])
        log.info("🤖 Telegram Bot online | ADMIN_ID=%d", ADMIN_ID)
        await tg.initialize()
        await tg.start()
        await tg.updater.start_polling(
            allowed_updates=Update.ALL_TYPES,
            drop_pending_updates=True,
        )
        # Giữ coroutine sống mãi
        while True:
            await asyncio.sleep(3600)

    try:
        loop.run_until_complete(_run())
    except Exception:
        log.exception("Bot thread crashed")
    finally:
        loop.close()

# ══════════════════════════════════════════════════════════════════════
# §11  STARTUP — gọi khi module được import (Gunicorn worker init)
# ══════════════════════════════════════════════════════════════════════
db_init()

_t = threading.Thread(target=_bot_thread_fn, daemon=True, name="TelegramBot")
_t.start()
log.info("🚀 Bot daemon thread started")

# ══════════════════════════════════════════════════════════════════════
# §12  LOCAL RUN
# ══════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    log.info("🌐 Flask listening on 0.0.0.0:%d", port)
    # debug=False, use_reloader=False → tránh fork thêm process con
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
