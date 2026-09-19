"""
Telegram Bot + Flask - Deploy on Render (Free Tier)
Architecture: Flask (main thread) + Bot (daemon thread)
DB: SQLite at /tmp/bot.db (resets on redeploy - acceptable for free tier)
"""

import os
import re
import math
import time
import hashlib
import asyncio
import logging
import secrets
import sqlite3
import threading
import requests
from datetime import datetime, timedelta
from collections import defaultdict

import nest_asyncio
from flask import Flask, request as flask_request, jsonify
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
BOT_TOKEN = "8931512528:AAE9CC1Kw_xRFO6QYJkQI6Su60dA7I0cDlQ"
ADMIN_ID   = 8284419367
DB_PATH    = "/tmp/bot.db"
PORT       = int(os.environ.get("PORT", 5000))
RENDER_URL = os.environ.get("RENDER_EXTERNAL_URL", "")  # auto-set by Render

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# FLASK APP
# ─────────────────────────────────────────────
app = Flask(__name__)

@app.route("/")
def health():
    return jsonify({"status": "OK", "bot": "running"}), 200

@app.route("/ping")
def ping():
    return "pong", 200

# ─────────────────────────────────────────────
# DATABASE
# ─────────────────────────────────────────────
def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS keys (
                key         TEXT PRIMARY KEY,
                duration    TEXT NOT NULL,
                expires_at  REAL,          -- NULL = vĩnh viễn
                user_id     INTEGER,       -- NULL = chưa dùng
                created_at  REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                user_id     INTEGER PRIMARY KEY,
                key         TEXT,
                activated_at REAL
            );

            CREATE TABLE IF NOT EXISTS weights (
                id          INTEGER PRIMARY KEY CHECK (id = 1),
                w_md5_val   REAL DEFAULT 0.40,
                w_ts_mod    REAL DEFAULT 0.30,
                w_entropy   REAL DEFAULT 0.20,
                w_checksum  REAL DEFAULT 0.10,
                xoai_hits   INTEGER DEFAULT 0,
                xoai_misses INTEGER DEFAULT 0,
                tao_hits    INTEGER DEFAULT 0,
                tao_misses  INTEGER DEFAULT 0,
                total_preds INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS predictions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                md5_input   TEXT NOT NULL,
                timestamp   REAL NOT NULL,
                result      TEXT NOT NULL,   -- 'XOAI' | 'TAO'
                score       INTEGER NOT NULL,
                feedback    TEXT,            -- 'correct' | 'wrong' | NULL
                created_at  REAL NOT NULL
            );

            INSERT OR IGNORE INTO weights (id) VALUES (1);
        """)
    log.info("DB initialized at %s", DB_PATH)

# ─────────────────────────────────────────────
# KEY UTILS
# ─────────────────────────────────────────────
DURATIONS = {
    "1d":  ("1 Ngày",   1),
    "3d":  ("3 Ngày",   3),
    "7d":  ("7 Ngày",   7),
    "30d": ("1 Tháng",  30),
    "365d":("1 Năm",    365),
    "inf": ("Vĩnh viễn", None),
}

def generate_key() -> str:
    rand = secrets.token_urlsafe(16).replace("-", "").replace("_", "")[:16].upper()
    return f"BoKietvidai-{rand}"

def create_keys(duration_code: str, count: int) -> list[str]:
    label, days = DURATIONS[duration_code]
    expires_at = (datetime.now() + timedelta(days=days)).timestamp() if days else None
    new_keys = [generate_key() for _ in range(count)]
    with get_conn() as conn:
        conn.executemany(
            "INSERT INTO keys (key, duration, expires_at, created_at) VALUES (?,?,?,?)",
            [(k, label, expires_at, datetime.now().timestamp()) for k in new_keys],
        )
    return new_keys

def activate_key(user_id: int, key: str) -> dict:
    """
    Returns: {"ok": bool, "msg": str}
    """
    with get_conn() as conn:
        # Xoá key hết hạn của user này trước
        conn.execute(
            "DELETE FROM keys WHERE user_id=? AND expires_at IS NOT NULL AND expires_at<?",
            (user_id, datetime.now().timestamp()),
        )
        conn.execute(
            "UPDATE users SET key=NULL, activated_at=NULL WHERE user_id=? AND key IN "
            "(SELECT key FROM keys WHERE user_id=? AND expires_at IS NOT NULL AND expires_at<?)",
            (user_id, user_id, datetime.now().timestamp()),
        )

        row = conn.execute("SELECT * FROM keys WHERE key=?", (key,)).fetchone()
        if not row:
            return {"ok": False, "msg": "❌ Key không tồn tại hoặc đã bị xoá."}
        if row["user_id"] is not None and row["user_id"] != user_id:
            return {"ok": False, "msg": "❌ Key này đã được người khác sử dụng."}
        if row["expires_at"] and row["expires_at"] < datetime.now().timestamp():
            conn.execute("DELETE FROM keys WHERE key=?", (key,))
            return {"ok": False, "msg": "❌ Key đã hết hạn và đã bị xoá."}

        # Xoá key cũ của user (nếu có)
        old = conn.execute("SELECT key FROM users WHERE user_id=?", (user_id,)).fetchone()
        if old and old["key"]:
            conn.execute(
                "UPDATE keys SET user_id=NULL WHERE key=? AND user_id=?",
                (old["key"], user_id),
            )

        # Bind key mới
        conn.execute("UPDATE keys SET user_id=? WHERE key=?", (user_id, key))
        conn.execute(
            "INSERT INTO users (user_id, key, activated_at) VALUES (?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET key=excluded.key, activated_at=excluded.activated_at",
            (user_id, key, datetime.now().timestamp()),
        )

        label = row["duration"]
        expires_at = row["expires_at"]
        if expires_at:
            exp_str = datetime.fromtimestamp(expires_at).strftime("%d/%m/%Y %H:%M")
            msg = f"✅ Kích hoạt thành công!\n📦 Gói: {label}\n⏰ Hết hạn: {exp_str}"
        else:
            msg = f"✅ Kích hoạt thành công!\n📦 Gói: {label} (Vĩnh viễn)"
        return {"ok": True, "msg": msg}

def check_user_key(user_id: int) -> bool:
    """True nếu user có key hợp lệ (Admin luôn True)."""
    if user_id == ADMIN_ID:
        return True
    with get_conn() as conn:
        user = conn.execute("SELECT key FROM users WHERE user_id=?", (user_id,)).fetchone()
        if not user or not user["key"]:
            return False
        key_row = conn.execute("SELECT expires_at FROM keys WHERE key=?", (user["key"],)).fetchone()
        if not key_row:
            # Key bị xoá
            conn.execute("UPDATE users SET key=NULL, activated_at=NULL WHERE user_id=?", (user_id,))
            return False
        if key_row["expires_at"] and key_row["expires_at"] < datetime.now().timestamp():
            # Hết hạn -> xoá
            conn.execute("DELETE FROM keys WHERE key=?", (user["key"],))
            conn.execute("UPDATE users SET key=NULL, activated_at=NULL WHERE user_id=?", (user_id,))
            return False
        return True

def list_keys(active_only=False) -> list:
    with get_conn() as conn:
        now = datetime.now().timestamp()
        if active_only:
            rows = conn.execute(
                "SELECT * FROM keys WHERE user_id IS NOT NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 50",
                (now,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM keys ORDER BY created_at DESC LIMIT 50"
            ).fetchall()
        return [dict(r) for r in rows]

# ─────────────────────────────────────────────
# ML PREDICTION ENGINE
# ─────────────────────────────────────────────
def _hex_to_numeric(md5: str) -> float:
    """Chuyển MD5 → giá trị số [0,1] bằng entropy-weighted sum."""
    val = int(md5, 16)
    max_val = 16**32 - 1
    return val / max_val

def _md5_entropy(md5: str) -> float:
    """Shannon entropy của MD5 string, normalised [0,1]."""
    freq = defaultdict(int)
    for c in md5:
        freq[c] += 1
    entropy = 0.0
    for count in freq.values():
        p = count / 32
        if p > 0:
            entropy -= p * math.log2(p)
    return entropy / math.log2(16)  # max entropy = log2(16)

def _timestamp_feature(ts: float) -> float:
    """
    Lấy micro-pattern của timestamp:
    - Phần thập phân giây (ms) → chaos signal
    - Giây % 60 → chu kỳ tín hiệu
    Combine → [0,1]
    """
    ms_part = (ts % 1)                    # 0–0.999...
    sec_cycle = (ts % 60) / 60            # 0–1
    return (ms_part * 0.6 + sec_cycle * 0.4)

def _checksum_feature(md5: str, ts: float) -> float:
    """XOR checksum giữa MD5 và timestamp bytes."""
    combined = f"{md5}{ts:.6f}".encode()
    h = hashlib.sha256(combined).digest()
    val = int.from_bytes(h[:4], "big")
    return val / (2**32 - 1)

def get_weights() -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM weights WHERE id=1").fetchone()
        return dict(row)

def _normalize_weights(w: dict) -> tuple:
    """Trả về (w_md5, w_ts, w_ent, w_chk) đã normalize tổng = 1."""
    total = w["w_md5_val"] + w["w_ts_mod"] + w["w_entropy"] + w["w_checksum"]
    if total == 0:
        return 0.4, 0.3, 0.2, 0.1
    return (
        w["w_md5_val"] / total,
        w["w_ts_mod"]  / total,
        w["w_entropy"] / total,
        w["w_checksum"] / total,
    )

def predict(md5: str, ts: float) -> dict:
    """
    Trả về {"result": "XOAI"|"TAO", "score": int, "confidence": float}

    Score XOAI: 3–10 điểm (tài)
    Score TÁO:  11–18 điểm (xỉu)

    Thuật toán:
    1. Tính 4 features từ MD5 + timestamp
    2. Weighted sum → composite [0,1]
    3. Map → score 3–18
    4. score ≤10 → XOÀI (tài), >10 → TÁO (xỉu)
    5. Confidence = khoảng cách so với biên 0.5
    """
    w = get_weights()
    wm, wt, we, wc = _normalize_weights(w)

    f_md5 = _hex_to_numeric(md5)
    f_ts   = _timestamp_feature(ts)
    f_ent  = _md5_entropy(md5)
    f_chk  = _checksum_feature(md5, ts)

    composite = wm * f_md5 + wt * f_ts + we * f_ent + wc * f_chk  # [0,1]

    # Map [0,1] → score [3,18]
    score = round(3 + composite * 15)
    score = max(3, min(18, score))

    result = "XOAI" if score <= 10 else "TAO"
    # Confidence: bao xa so với ngưỡng (10.5 = trung tâm)
    distance = abs(score - 10.5) / 7.5  # normalise
    confidence = round(50 + distance * 50)  # 50–100%

    return {"result": result, "score": score, "confidence": confidence,
            "features": {"f_md5": round(f_md5, 4), "f_ts": round(f_ts, 4),
                         "f_ent": round(f_ent, 4), "f_chk": round(f_chk, 4)}}

def save_prediction(user_id: int, md5: str, ts: float, pred: dict) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO predictions (user_id, md5_input, timestamp, result, score, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (user_id, md5, ts, pred["result"], pred["score"], datetime.now().timestamp()),
        )
        conn.execute("UPDATE weights SET total_preds=total_preds+1 WHERE id=1")
        return cur.lastrowid

def update_feedback(pred_id: int, is_correct: bool):
    """
    Bayesian-style weight update:
    - Đúng → tăng trọng số feature nào đóng góp nhiều nhất
    - Sai → giảm trọng số đó, tăng các feature khác
    Learning rate = 0.02 (nhỏ để ổn định)
    """
    LR = 0.02
    with get_conn() as conn:
        pred = conn.execute("SELECT * FROM predictions WHERE id=?", (pred_id,)).fetchone()
        if not pred or pred["feedback"]:
            return False  # Đã feedback hoặc không tồn tại

        feedback = "correct" if is_correct else "wrong"
        conn.execute("UPDATE predictions SET feedback=? WHERE id=?", (feedback, pred_id))

        # Cập nhật hit/miss counters
        result = pred["result"]
        if is_correct:
            if result == "XOAI":
                conn.execute("UPDATE weights SET xoai_hits=xoai_hits+1 WHERE id=1")
            else:
                conn.execute("UPDATE weights SET tao_hits=tao_hits+1 WHERE id=1")
        else:
            if result == "XOAI":
                conn.execute("UPDATE weights SET xoai_misses=xoai_misses+1 WHERE id=1")
            else:
                conn.execute("UPDATE weights SET tao_misses=tao_misses+1 WHERE id=1")

        # Gradient update: sai thì đảo ngược trọng số nhẹ
        w = conn.execute("SELECT * FROM weights WHERE id=1").fetchone()
        sign = 1 if is_correct else -1
        # Feature md5 và entropy thường ổn định hơn → điều chỉnh ts và checksum
        new_w_ts  = max(0.05, min(0.60, w["w_ts_mod"]  + sign * LR))
        new_w_chk = max(0.05, min(0.40, w["w_checksum"] + sign * LR * 0.5))
        # Compensate
        delta_ts  = new_w_ts  - w["w_ts_mod"]
        delta_chk = new_w_chk - w["w_checksum"]
        new_w_md5 = max(0.10, w["w_md5_val"] - delta_ts * 0.6 - delta_chk * 0.4)
        new_w_ent = max(0.05, w["w_entropy"]  - delta_ts * 0.4 - delta_chk * 0.6)

        conn.execute(
            "UPDATE weights SET w_md5_val=?, w_ts_mod=?, w_entropy=?, w_checksum=? WHERE id=1",
            (round(new_w_md5, 4), round(new_w_ts, 4),
             round(new_w_ent, 4), round(new_w_chk, 4)),
        )
        return True

# ─────────────────────────────────────────────
# BOT HANDLERS
# ─────────────────────────────────────────────
WAITING_MD5  = {}   # user_id → True
WAITING_KEY  = {}   # user_id → True
WAITING_COUNT = {}  # user_id → duration_code

def build_main_menu(user_id: int) -> InlineKeyboardMarkup:
    buttons = [
        [InlineKeyboardButton("🔍 [1] Phân tích MD5", callback_data="menu_md5")],
        [InlineKeyboardButton("🔑 [2] Nhập Key",      callback_data="menu_key")],
    ]
    if user_id == ADMIN_ID:
        buttons.append([InlineKeyboardButton("⚙️ [3] Tạo Key (Admin)", callback_data="menu_admin")])
        buttons.append([InlineKeyboardButton("📋 [4] Quản lý Key",      callback_data="menu_listkeys")])
    return InlineKeyboardMarkup(buttons)

def build_duration_menu() -> InlineKeyboardMarkup:
    buttons = [
        [InlineKeyboardButton("1 Ngày",    callback_data="dur_1d"),
         InlineKeyboardButton("3 Ngày",    callback_data="dur_3d")],
        [InlineKeyboardButton("7 Ngày",    callback_data="dur_7d"),
         InlineKeyboardButton("1 Tháng",   callback_data="dur_30d")],
        [InlineKeyboardButton("1 Năm",     callback_data="dur_365d"),
         InlineKeyboardButton("Vĩnh viễn", callback_data="dur_inf")],
        [InlineKeyboardButton("↩️ Quay lại", callback_data="back_main")],
    ]
    return InlineKeyboardMarkup(buttons)

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    uid  = user.id
    # Clear trạng thái chờ
    WAITING_MD5.pop(uid, None)
    WAITING_KEY.pop(uid, None)
    WAITING_COUNT.pop(uid, None)

    has_key = check_user_key(uid)
    status  = "✅ Key hợp lệ" if has_key else "❌ Chưa có key"
    text = (
        f"👋 Xin chào *{user.first_name}*!\n\n"
        f"🤖 *Bot Phân Tích Tài Xỉu*\n"
        f"📊 Trạng thái: {status}\n\n"
        f"Chọn chức năng bên dưới:"
    )
    await update.message.reply_text(
        text, parse_mode="Markdown",
        reply_markup=build_main_menu(uid),
    )

async def cb_handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    uid  = query.from_user.id
    data = query.data

    # ── Main Menu ──────────────────────────────
    if data == "back_main":
        WAITING_MD5.pop(uid, None)
        WAITING_KEY.pop(uid, None)
        WAITING_COUNT.pop(uid, None)
        has_key = check_user_key(uid)
        status  = "✅ Key hợp lệ" if has_key else "❌ Chưa có key"
        await query.edit_message_text(
            f"🤖 *Bot Phân Tích Tài Xỉu*\n📊 Trạng thái: {status}\n\nChọn chức năng:",
            parse_mode="Markdown",
            reply_markup=build_main_menu(uid),
        )

    elif data == "menu_md5":
        if not check_user_key(uid):
            await query.edit_message_text(
                "❌ Bạn chưa có key hợp lệ!\nVui lòng nhập key trước (chức năng [2]).\n\n"
                "Liên hệ Admin để mua key.",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("↩️ Quay lại", callback_data="back_main")
                ]]),
            )
            return
        WAITING_MD5[uid] = True
        await query.edit_message_text(
            "🔍 *Phân tích MD5*\n\n"
            "Vui lòng gửi chuỗi MD5 cần phân tích:\n"
            "_(32 ký tự hex, ví dụ: d41d8cd98f00b204e9800998ecf8427e)_",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("↩️ Quay lại", callback_data="back_main")
            ]]),
        )

    elif data == "menu_key":
        WAITING_KEY[uid] = True
        await query.edit_message_text(
            "🔑 *Nhập Key kích hoạt*\n\n"
            "Vui lòng gửi key của bạn:\n"
            "_(Định dạng: BoKietvidai-XXXXXXXXXXXXXXXX)_",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("↩️ Quay lại", callback_data="back_main")
            ]]),
        )

    elif data == "menu_admin":
        if uid != ADMIN_ID:
            await query.answer("⛔ Không có quyền!", show_alert=True)
            return
        await query.edit_message_text(
            "⚙️ *Tạo Key mới*\n\nChọn thời hạn cho key:",
            parse_mode="Markdown",
            reply_markup=build_duration_menu(),
        )

    elif data == "menu_listkeys":
        if uid != ADMIN_ID:
            await query.answer("⛔ Không có quyền!", show_alert=True)
            return
        await _show_key_list(query)

    # ── Duration select → hỏi số lượng ───────
    elif data.startswith("dur_"):
        if uid != ADMIN_ID:
            await query.answer("⛔ Không có quyền!", show_alert=True)
            return
        dur_code = data[4:]
        WAITING_COUNT[uid] = dur_code
        label = DURATIONS[dur_code][0]
        await query.edit_message_text(
            f"⚙️ *Tạo Key - {label}*\n\n"
            f"Nhập số lượng key muốn tạo (1–100):",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("↩️ Quay lại", callback_data="menu_admin")
            ]]),
        )

    # ── Feedback ──────────────────────────────
    elif data.startswith("fb_"):
        parts = data.split("_")   # fb_{correct|wrong}_{pred_id}
        is_correct = parts[1] == "correct"
        pred_id    = int(parts[2])
        changed    = update_feedback(pred_id, is_correct)
        if changed:
            icon = "✅" if is_correct else "❌"
            w    = get_weights()
            xoai_acc = _accuracy(w["xoai_hits"], w["xoai_misses"])
            tao_acc  = _accuracy(w["tao_hits"],  w["tao_misses"])
            await query.edit_message_reply_markup(reply_markup=None)
            await query.message.reply_text(
                f"{icon} Đã ghi nhận phản hồi!\n\n"
                f"📈 *Độ chính xác hiện tại:*\n"
                f"🍋 XOÀI (Tài): {xoai_acc}%\n"
                f"🍎 TÁO (Xỉu): {tao_acc}%\n"
                f"🔄 Model đã được cập nhật.",
                parse_mode="Markdown",
            )
        else:
            await query.answer("Bạn đã phản hồi rồi!", show_alert=True)

    # ── Xem key list filter ───────────────────
    elif data == "keys_all":
        await _show_key_list(query, active_only=False)
    elif data == "keys_active":
        await _show_key_list(query, active_only=True)

def _accuracy(hits: int, misses: int) -> str:
    total = hits + misses
    if total == 0:
        return "N/A"
    return str(round(hits / total * 100))

async def _show_key_list(query, active_only=False):
    keys = list_keys(active_only=active_only)
    if not keys:
        text = "📋 Chưa có key nào."
    else:
        now  = datetime.now().timestamp()
        lines = []
        for k in keys[:20]:  # hiện tối đa 20
            status = "🟢" if (k["expires_at"] is None or k["expires_at"] > now) else "🔴"
            user   = f"→ User {k['user_id']}" if k["user_id"] else "→ Chưa dùng"
            exp    = ("Vĩnh viễn" if not k["expires_at"]
                      else datetime.fromtimestamp(k["expires_at"]).strftime("%d/%m/%y"))
            lines.append(f"{status} `{k['key'][:24]}…`\n   {k['duration']} | {exp} | {user}")
        text = (
            f"📋 *Danh sách Key* ({'Active' if active_only else 'Tất cả'})\n\n"
            + "\n\n".join(lines)
            + (f"\n\n_(Hiển thị {len(lines)}/{len(keys)})_" if len(keys) > 20 else "")
        )
    buttons = [
        [InlineKeyboardButton("🟢 Đang dùng", callback_data="keys_active"),
         InlineKeyboardButton("📋 Tất cả",    callback_data="keys_all")],
        [InlineKeyboardButton("↩️ Quay lại",  callback_data="back_main")],
    ]
    await query.edit_message_text(
        text, parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(buttons),
    )

async def msg_handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid  = update.effective_user.id
    text = update.message.text.strip()

    # ── Nhập Key ──────────────────────────────
    if WAITING_KEY.pop(uid, False):
        result = activate_key(uid, text)
        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("↩️ Menu chính", callback_data="back_main")
        ]])
        await update.message.reply_text(result["msg"], reply_markup=kb)
        return

    # ── Nhập số lượng key (Admin) ─────────────
    if uid in WAITING_COUNT:
        dur_code = WAITING_COUNT[uid]
        if not text.isdigit() or not (1 <= int(text) <= 100):
            await update.message.reply_text("⚠️ Vui lòng nhập số từ 1 đến 100.")
            return
        count = int(text)
        WAITING_COUNT.pop(uid)
        keys  = create_keys(dur_code, count)
        label = DURATIONS[dur_code][0]

        # Gửi danh sách key
        key_text = "\n".join(f"`{k}`" for k in keys)
        chunks   = _split_text(key_text, 3800)
        for i, chunk in enumerate(chunks):
            header = (f"✅ *Đã tạo {count} key - {label}*\n\n" if i == 0
                      else f"_(tiếp theo {i+1}/{len(chunks)})_\n\n")
            await update.message.reply_text(
                header + chunk, parse_mode="Markdown",
                reply_markup=(InlineKeyboardMarkup([[
                    InlineKeyboardButton("↩️ Menu chính", callback_data="back_main")
                ]]) if i == len(chunks) - 1 else None),
            )
        return

    # ── Phân tích MD5 ─────────────────────────
    if WAITING_MD5.pop(uid, False):
        md5_input = text.lower().strip()
        if not re.fullmatch(r"[0-9a-f]{32}", md5_input):
            await update.message.reply_text(
                "❌ Chuỗi MD5 không hợp lệ!\nCần đúng 32 ký tự hex (0-9, a-f).\n\nThử lại:",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("↩️ Quay lại", callback_data="back_main")
                ]]),
            )
            WAITING_MD5[uid] = True  # cho thử lại
            return

        ts    = time.time()
        pred  = predict(md5_input, ts)
        pid   = save_prediction(uid, md5_input, ts, pred)
        w     = get_weights()
        xoai_acc = _accuracy(w["xoai_hits"], w["xoai_misses"])
        tao_acc  = _accuracy(w["tao_hits"],  w["tao_misses"])

        if pred["result"] == "XOAI":
            result_icon = "🍋"
            result_name = "XOÀI (TÀI)"
            score_range = f"Điểm: {pred['score']}/10"
        else:
            result_icon = "🍎"
            result_name = "TÁO (XỈU)"
            score_range = f"Điểm: {pred['score']}/18"

        ts_str = datetime.fromtimestamp(ts).strftime("%H:%M:%S.%f")[:-3]
        text_out = (
            f"🔍 *Kết quả Phân tích MD5*\n\n"
            f"📥 MD5: `{md5_input[:16]}…`\n"
            f"⏱ Timestamp: `{ts_str}`\n\n"
            f"━━━━━━━━━━━━━━━━━\n"
            f"{result_icon} Dự đoán: *{result_name}*\n"
            f"📊 {score_range}\n"
            f"🎯 Độ tin cậy: *{pred['confidence']}%*\n"
            f"━━━━━━━━━━━━━━━━━\n\n"
            f"📈 Độ chính xác Model:\n"
            f"🍋 XOÀI: {xoai_acc}% | 🍎 TÁO: {tao_acc}%\n\n"
            f"_Kết quả có đúng không?_"
        )
        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ ĐÚNG", callback_data=f"fb_correct_{pid}"),
            InlineKeyboardButton("❌ SAI",  callback_data=f"fb_wrong_{pid}"),
        ]])
        await update.message.reply_text(text_out, parse_mode="Markdown", reply_markup=kb)
        return

    # ── Tin nhắn không rõ ─────────────────────
    await update.message.reply_text(
        "Dùng lệnh /start để mở menu.",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("🏠 Menu chính", callback_data="back_main")
        ]]),
    )

def _split_text(text: str, max_len: int) -> list[str]:
    """Chia text dài thành nhiều chunk."""
    lines  = text.split("\n")
    chunks = []
    current = []
    current_len = 0
    for line in lines:
        if current_len + len(line) + 1 > max_len:
            chunks.append("\n".join(current))
            current = [line]
            current_len = len(line)
        else:
            current.append(line)
            current_len += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks or [""]

# ─────────────────────────────────────────────
# BOT RUNNER (Daemon Thread)
# ─────────────────────────────────────────────
def run_bot():
    nest_asyncio.apply()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _start():
        bot_app = (
            Application.builder()
            .token(BOT_TOKEN)
            .read_timeout(30)
            .write_timeout(30)
            .connect_timeout(30)
            .pool_timeout(30)
            .build()
        )
        bot_app.add_handler(CommandHandler("start", cmd_start))
        bot_app.add_handler(CallbackQueryHandler(cb_handler))
        bot_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, msg_handler))

        log.info("Bot starting (polling)…")
        await bot_app.initialize()
        await bot_app.start()
        await bot_app.updater.start_polling(
            allowed_updates=Update.ALL_TYPES,
            drop_pending_updates=True,
        )
        # Chạy mãi mãi
        while True:
            await asyncio.sleep(3600)

    loop.run_until_complete(_start())

# ─────────────────────────────────────────────
# KEEP-ALIVE (chống sleep Render Free)
# ─────────────────────────────────────────────
def keep_alive():
    """Ping bản thân mỗi 14 phút để Render Free không sleep."""
    time.sleep(60)  # đợi server khởi động
    while True:
        try:
            if RENDER_URL:
                url = RENDER_URL.rstrip("/") + "/ping"
                resp = requests.get(url, timeout=10)
                log.info("Keep-alive ping → %s %s", url, resp.status_code)
            else:
                log.info("Keep-alive: RENDER_EXTERNAL_URL not set, skipping")
        except Exception as e:
            log.warning("Keep-alive error: %s", e)
        time.sleep(14 * 60)  # 14 phút

# ─────────────────────────────────────────────
# STARTUP — chạy khi module được import (gunicorn) HOẶC trực tiếp
# ─────────────────────────────────────────────
def _startup():
    """Khởi động DB + Bot thread + Keep-alive thread.
    Gọi 1 lần duy nhất dù chạy qua gunicorn hay python main.py.
    """
    init_db()

    bot_thread = threading.Thread(target=run_bot, daemon=True, name="BotThread")
    bot_thread.start()
    log.info("Bot thread started")

    ka_thread = threading.Thread(target=keep_alive, daemon=True, name="KeepAlive")
    ka_thread.start()
    log.info("Keep-alive thread started")

# Chạy ngay khi module load (bắt cả gunicorn lẫn python main.py)
_startup()

if __name__ == "__main__":
    # Chạy trực tiếp (dev / debug): Flask dev server
    log.info("Flask dev server starting on port %s", PORT)
    app.run(host="0.0.0.0", port=PORT, debug=False, use_reloader=False)
