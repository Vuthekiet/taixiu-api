# 1. CẤU HÌNH – CHỈ SỬA 2 DÒNG NÀY
# ──────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN: str = "7934446128:AAHio5BnyLQXEtwpwFSaW5azYPxhuYjAFmY"   # <-- dán token bot vào đây
ADMIN_ID: int           = 8284419367                # <-- dán Telegram User ID Admin vào đây

# ──────────────────────────────────────────────────────────────
# 2. IMPORT
# ──────────────────────────────────────────────────────────────
import asyncio
import hashlib
import logging
import math
import re
import secrets
import sqlite3
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

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

# ──────────────────────────────────────────────────────────────
# 3. LOGGING
# ──────────────────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("bokiet_bot.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("BoKietBot")

# ──────────────────────────────────────────────────────────────
# 4. HẰNG SỐ CONVERSATION STATE
# ──────────────────────────────────────────────────────────────
STATE_WAITING_MD5  = 1
STATE_WAITING_KEY  = 2
STATE_WAITING_TIER = 3

# ──────────────────────────────────────────────────────────────
# 5. DATABASE – SQLite
# ──────────────────────────────────────────────────────────────
DB_PATH = "bokiet_keys.db"

def db_init() -> None:
    """Khởi tạo bảng CSDL nếu chưa có."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS keys (
                key_code        TEXT PRIMARY KEY,
                duration_label  TEXT NOT NULL,
                expires_at      REAL,           -- Unix timestamp, NULL = vĩnh viễn
                activated_by    INTEGER,        -- Telegram user_id đã kích hoạt
                activated_at    REAL,           -- Unix timestamp lúc kích hoạt
                created_at      REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id         INTEGER PRIMARY KEY,
                active_key      TEXT,
                key_expires_at  REAL            -- cache để check nhanh
            )
        """)
        conn.commit()
    logger.info("✅ Database đã sẵn sàng: %s", DB_PATH)


# ---------- KEY helpers ----------

def db_create_key(duration_label: str, expires_at: Optional[float]) -> str:
    """Sinh key mới, lưu vào DB, trả về chuỗi key."""
    key_code = f"BoKietvidai-{secrets.token_hex(8).upper()}"
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT INTO keys (key_code, duration_label, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (key_code, duration_label, expires_at, time.time()),
        )
        conn.commit()
    return key_code


def db_activate_key(key_code: str, user_id: int) -> dict:
    """
    Kích hoạt key cho user.
    Trả về dict: {"ok": bool, "msg": str, "expires_at": float|None}
    """
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT duration_label, expires_at, activated_by FROM keys WHERE key_code = ?",
            (key_code,),
        ).fetchone()

        if row is None:
            return {"ok": False, "msg": "❌ Key không tồn tại!"}

        duration_label, expires_at, activated_by = row

        # Kiểm tra key đã dùng bởi người khác
        if activated_by is not None and activated_by != user_id:
            return {"ok": False, "msg": "❌ Key này đã được sử dụng bởi người khác!"}

        # Kiểm tra key hết hạn (với key đã kích hoạt trước đó)
        if expires_at is not None and time.time() > expires_at:
            return {"ok": False, "msg": "❌ Key đã hết hạn, không thể kích hoạt lại!"}

        now = time.time()

        # Nếu key chưa có activated_by → lần kích hoạt đầu, tính expires từ bây giờ
        if activated_by is None:
            # Tính lại expires_at dựa trên duration_label (kích hoạt = bắt đầu đếm)
            new_expires = _calc_expires(duration_label)
            conn.execute(
                "UPDATE keys SET activated_by=?, activated_at=?, expires_at=? WHERE key_code=?",
                (user_id, now, new_expires, key_code),
            )
            expires_at = new_expires

        # Cập nhật bảng users
        conn.execute(
            "INSERT OR REPLACE INTO users (user_id, active_key, key_expires_at) VALUES (?, ?, ?)",
            (user_id, key_code, expires_at),
        )
        conn.commit()

    return {"ok": True, "msg": "✅ Kích hoạt thành công!", "expires_at": expires_at}


def db_check_access(user_id: int) -> dict:
    """Kiểm tra user có quyền dùng phân tích MD5 không."""
    # Admin luôn có quyền
    if user_id == ADMIN_ID:
        return {"ok": True, "msg": "Admin"}

    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT active_key, key_expires_at FROM users WHERE user_id = ?",
            (user_id,),
        ).fetchone()

    if row is None or row[0] is None:
        return {"ok": False, "msg": "no_key"}

    _key, expires_at = row

    if expires_at is not None and time.time() > expires_at:
        return {"ok": False, "msg": "expired"}

    return {"ok": True, "msg": "active", "expires_at": expires_at}


def db_get_user_key_info(user_id: int) -> Optional[dict]:
    """Lấy thông tin key hiện tại của user (dùng cho hiển thị)."""
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT active_key, key_expires_at FROM users WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    if row is None:
        return None
    return {"key": row[0], "expires_at": row[1]}


# ---------- Helpers ----------

def _calc_expires(duration_label: str) -> Optional[float]:
    """Tính Unix timestamp hết hạn từ nhãn thời hạn."""
    now = datetime.now(timezone.utc)
    mapping = {
        "1 ngày":    now + timedelta(days=1),
        "3 ngày":    now + timedelta(days=3),
        "7 ngày":    now + timedelta(days=7),
        "1 tháng":   now + timedelta(days=30),
        "1 năm":     now + timedelta(days=365),
        "Vĩnh viễn": None,
    }
    result = mapping.get(duration_label)
    return result.timestamp() if result is not None else None


def _fmt_expire(expires_at: Optional[float]) -> str:
    """Format thời gian hết hạn ra chuỗi đọc được."""
    if expires_at is None:
        return "♾️ Vĩnh viễn"
    dt = datetime.fromtimestamp(expires_at, tz=timezone.utc).astimezone()
    return dt.strftime("%d/%m/%Y %H:%M:%S")


# ──────────────────────────────────────────────────────────────
# 6. THUẬT TOÁN PHÂN TÍCH MD5
# ──────────────────────────────────────────────────────────────

def _shannon_entropy(byte_seq: bytes) -> float:
    """
    Tính Shannon Entropy (bits) của chuỗi byte.
    H = -Σ p(x) * log2(p(x))
    Giá trị 0..8: càng cao = càng ngẫu nhiên.
    """
    if not byte_seq:
        return 0.0
    freq = Counter(byte_seq)
    total = len(byte_seq)
    return -sum((c / total) * math.log2(c / total) for c in freq.values())


def analyze_md5(md5_hex: str) -> dict:
    """
    Thuật toán lõi:
    1. Kết hợp MD5 gốc với Timestamp hiện tại (ms) → tạo Seed tổng hợp
    2. Hash Seed bằng SHA-256 → lấy 16 bytes đầu làm dữ liệu phân tích
    3. Chuyển từng byte → dice value (mod 6 + 1, range 1-6)
    4. Mô phỏng 3 xúc xắc × N lần → tính xác suất XOÀI/TÁO
    5. Tính Shannon Entropy của seed bytes

    Trả về dict: prediction, confidence, entropy, timestamp_ms, seed_hash
    """
    timestamp_ms = int(time.time() * 1000)

    # --- Bước 1: Tạo Seed tổng hợp ---
    seed_raw = f"{md5_hex.lower()}:{timestamp_ms}"
    seed_hash_hex = hashlib.sha256(seed_raw.encode()).hexdigest()

    # --- Bước 2: Lấy bytes từ seed ---
    seed_bytes = bytes.fromhex(seed_hash_hex)           # 32 bytes

    # --- Bước 3: Entropy ---
    entropy = _shannon_entropy(seed_bytes)

    # --- Bước 4: Mô phỏng xúc xắc ---
    # Dùng tất cả 32 bytes, mỗi nhóm 3 bytes = 1 lượt tung 3 xúc xắc
    # → ta có 10 lượt tung (30 bytes), 2 bytes còn lại làm tie-breaker
    scores = []
    for i in range(0, 30, 3):
        d1 = (seed_bytes[i]     % 6) + 1
        d2 = (seed_bytes[i + 1] % 6) + 1
        d3 = (seed_bytes[i + 2] % 6) + 1
        scores.append(d1 + d2 + d3)

    # --- Bước 5: Đếm XOÀI/TÁO ---
    xoai_count = sum(1 for s in scores if 3 <= s <= 10)   # Tài nhỏ
    tao_count  = sum(1 for s in scores if 11 <= s <= 18)  # Tài lớn

    total = xoai_count + tao_count

    if total == 0:
        # Trường hợp cực kỳ hi hữu (không thể xảy ra với dice 1-6)
        prediction = "XOÀI"
        confidence = 50.0
    elif xoai_count > tao_count:
        prediction = "🍊 XOÀI"
        confidence = round((xoai_count / total) * 100, 2)
    elif tao_count > xoai_count:
        prediction = "🍎 TÁO"
        confidence = round((tao_count / total) * 100, 2)
    else:
        # Tie → dùng tie-breaker byte cuối
        tie_byte = seed_bytes[30] + seed_bytes[31]
        if tie_byte % 2 == 0:
            prediction = "🍊 XOÀI"
        else:
            prediction = "🍎 TÁO"
        confidence = 50.0

    return {
        "prediction":    prediction,
        "confidence":    confidence,
        "entropy":       round(entropy, 4),
        "timestamp_ms":  timestamp_ms,
        "seed_hash":     seed_hash_hex[:12] + "...",  # rút gọn để hiển thị
        "xoai_count":    xoai_count,
        "tao_count":     tao_count,
    }


# ──────────────────────────────────────────────────────────────
# 7. KEYBOARDS & MESSAGES
# ──────────────────────────────────────────────────────────────

def main_menu_keyboard(user_id: int) -> InlineKeyboardMarkup:
    buttons = [
        [InlineKeyboardButton("🔍 [1] Phân tích MD5", callback_data="menu_analyze")],
        [InlineKeyboardButton("🔑 [2] Nhập Key",       callback_data="menu_enterkey")],
    ]
    if user_id == ADMIN_ID:
        buttons.append(
            [InlineKeyboardButton("⚙️ [3] Tạo Key  (Admin)", callback_data="menu_createkey")]
        )
    return InlineKeyboardMarkup(buttons)


def tier_keyboard() -> InlineKeyboardMarkup:
    tiers = [
        ("1️⃣  1 ngày",    "tier_1d"),
        ("2️⃣  3 ngày",    "tier_3d"),
        ("3️⃣  7 ngày",    "tier_7d"),
        ("4️⃣  1 tháng",   "tier_1m"),
        ("5️⃣  1 năm",     "tier_1y"),
        ("6️⃣  Vĩnh viễn", "tier_inf"),
    ]
    buttons = [[InlineKeyboardButton(label, callback_data=cb)] for label, cb in tiers]
    buttons.append([InlineKeyboardButton("🔙 Quay lại", callback_data="menu_back")])
    return InlineKeyboardMarkup(buttons)


WELCOME_MSG = (
    "👋 *Chào mừng đến với BoKiet Dice Bot!*\n\n"
    "🎲 Bot phân tích và dự đoán kết quả Xúc xắc dựa trên chuỗi MD5.\n\n"
    "📌 *Cửa dự đoán:*\n"
    "   🍊 *XOÀI* → Tổng 3 xúc xắc: 3–10 điểm\n"
    "   🍎 *TÁO*  → Tổng 3 xúc xắc: 11–18 điểm\n\n"
    "👇 Chọn chức năng bên dưới:"
)


# ──────────────────────────────────────────────────────────────
# 8. HANDLERS
# ──────────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Lệnh /start – hiển thị menu chính."""
    user = update.effective_user

    # Chỉ cho phép Private Chat
    if update.effective_chat.type != "private":
        await update.message.reply_text("⚠️ Bot chỉ hoạt động trong chat riêng (Private Chat).")
        return ConversationHandler.END

    await update.message.reply_text(
        WELCOME_MSG,
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=main_menu_keyboard(user.id),
    )
    return ConversationHandler.END


# ──────── Menu callbacks ────────

async def cb_menu_analyze(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Chọn [1] Phân tích MD5."""
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id

    access = db_check_access(user_id)
    if not access["ok"]:
        if access["msg"] == "no_key":
            msg = "🔒 Bạn chưa kích hoạt Key!\nVui lòng chọn *[2] Nhập Key* trước."
        else:
            msg = "⏰ Key của bạn đã hết hạn!\nVui lòng nhập Key mới."
        await query.edit_message_text(
            msg,
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_menu_keyboard(user_id),
        )
        return ConversationHandler.END

    # Hiển thị thông tin hết hạn nếu có
    info = db_get_user_key_info(user_id)
    expire_line = ""
    if info and user_id != ADMIN_ID:
        expire_line = f"\n⏳ Key hết hạn: `{_fmt_expire(info['expires_at'])}`\n"

    await query.edit_message_text(
        f"🔍 *Phân tích MD5*{expire_line}\n\n"
        "📋 Hãy gửi chuỗi *MD5* (32 ký tự hex) để phân tích:\n\n"
        "_Ví dụ: `d41d8cd98f00b204e9800998ecf8427e`_",
        parse_mode=ParseMode.MARKDOWN,
    )
    return STATE_WAITING_MD5


async def cb_menu_enterkey(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Chọn [2] Nhập Key."""
    query = update.callback_query
    await query.answer()

    await query.edit_message_text(
        "🔑 *Nhập Key kích hoạt*\n\n"
        "Hãy dán chuỗi Key của bạn vào đây:\n"
        "_Định dạng: `BoKietvidai-XXXXXXXXXXXXXXXX`_",
        parse_mode=ParseMode.MARKDOWN,
    )
    return STATE_WAITING_KEY


async def cb_menu_createkey(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Chọn [3] Tạo Key – chỉ Admin."""
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id

    if user_id != ADMIN_ID:
        await query.edit_message_text(
            "🚫 Bạn không có quyền truy cập chức năng này!",
            reply_markup=main_menu_keyboard(user_id),
        )
        return ConversationHandler.END

    await query.edit_message_text(
        "⚙️ *Tạo Key mới*\n\nChọn thời hạn cho Key:",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=tier_keyboard(),
    )
    return STATE_WAITING_TIER


async def cb_menu_back(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Nút Quay lại → main menu."""
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id

    await query.edit_message_text(
        WELCOME_MSG,
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=main_menu_keyboard(user_id),
    )
    return ConversationHandler.END


# ──────── Tier selection (Admin tạo key) ────────

TIER_MAP = {
    "tier_1d":  ("1 ngày",    1),
    "tier_3d":  ("3 ngày",    3),
    "tier_7d":  ("7 ngày",    7),
    "tier_1m":  ("1 tháng",   30),
    "tier_1y":  ("1 năm",     365),
    "tier_inf": ("Vĩnh viễn", None),
}


async def cb_tier_selected(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Admin chọn thời hạn → sinh key → hiển thị."""
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id

    if user_id != ADMIN_ID:
        await query.edit_message_text("🚫 Không có quyền!")
        return ConversationHandler.END

    tier_data  = TIER_MAP[query.data]
    label      = tier_data[0]
    days       = tier_data[1]

    # Tính expires: đếm từ thời điểm USER kích hoạt (không phải tạo)
    # → expires_at trong DB sẽ được cập nhật lại khi user nhập key
    # → Lúc tạo: lưu tạm None, khi activate mới tính
    # Nhưng ta cần lưu duration_label để tính sau
    expires_placeholder = None  # Sẽ tính lại khi user kích hoạt

    key_code = db_create_key(label, expires_placeholder)

    expire_display = f"`{label}` (bắt đầu tính từ lúc User kích hoạt)" if days else "♾️ Vĩnh viễn"

    await query.edit_message_text(
        f"✅ *Key đã được tạo thành công!*\n\n"
        f"🔑 Key:\n`{key_code}`\n\n"
        f"⏳ Thời hạn: {expire_display}\n\n"
        f"📋 _Copy key ở trên và gửi cho người dùng._",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("➕ Tạo Key khác", callback_data="menu_createkey")],
            [InlineKeyboardButton("🏠 Menu chính",   callback_data="menu_back")],
        ]),
    )
    return ConversationHandler.END


# ──────── Nhận MD5 từ user ────────

MD5_RE = re.compile(r"^[0-9a-fA-F]{32}$")


async def handle_md5_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Nhận chuỗi MD5, phân tích, trả kết quả."""
    user    = update.effective_user
    user_id = user.id
    text    = (update.message.text or "").strip()

    # Validate MD5
    if not MD5_RE.match(text):
        await update.message.reply_text(
            "⚠️ *Chuỗi không hợp lệ!*\n\n"
            "MD5 phải gồm đúng *32 ký tự Hex* (0-9, a-f).\n"
            "Vui lòng gửi lại:",
            parse_mode=ParseMode.MARKDOWN,
        )
        return STATE_WAITING_MD5  # Giữ nguyên state, chờ nhập lại

    # Kiểm tra quyền truy cập lần nữa (key có thể hết hạn giữa chừng)
    access = db_check_access(user_id)
    if not access["ok"]:
        await update.message.reply_text(
            "⏰ *Key của bạn vừa hết hạn!*\nVui lòng nhập Key mới.",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_menu_keyboard(user_id),
        )
        return ConversationHandler.END

    # Gửi thông báo "đang xử lý..."
    processing_msg = await update.message.reply_text("⏳ Đang phân tích...")

    # Phân tích
    result = analyze_md5(text)

    # Xác định emoji cửa
    cua_emoji = "🍊" if "XOÀI" in result["prediction"] else "🍎"

    # Thanh progress ASCII cho confidence
    bar_len   = 20
    filled    = int(result["confidence"] / 100 * bar_len)
    bar       = "█" * filled + "░" * (bar_len - filled)

    response = (
        f"━━━━━━━━━━━━━━━━━━━━━━\n"
        f"🎲 *KẾT QUẢ PHÂN TÍCH XÚC XẮC*\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📥 MD5: `{text.lower()}`\n"
        f"⏱ Timestamp: `{result['timestamp_ms']} ms`\n"
        f"🔐 Seed hash: `{result['seed_hash']}`\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{cua_emoji} *DỰ ĐOÁN:  {result['prediction']}*\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📊 Độ tin cậy:\n"
        f"`[{bar}]`\n"
        f"     *{result['confidence']}%*\n\n"
        f"📈 Shannon Entropy: `{result['entropy']} bits`\n"
        f"   _(8 bits = hoàn toàn ngẫu nhiên)_\n\n"
        f"🍊 Mẫu XOÀI (3–10): `{result['xoai_count']}/10`\n"
        f"🍎 Mẫu TÁO  (11–18): `{result['tao_count']}/10`\n\n"
        f"⚠️ _Mỗi lần phân tích dùng Timestamp thực tế,_\n"
        f"_kết quả có thể thay đổi theo thời gian._"
    )

    await processing_msg.delete()
    await update.message.reply_text(
        response,
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("🔄 Phân tích MD5 khác", callback_data="menu_analyze")],
            [InlineKeyboardButton("🏠 Menu chính",          callback_data="menu_back")],
        ]),
    )
    return ConversationHandler.END


# ──────── Nhận Key từ user ────────

KEY_RE = re.compile(r"^BoKietvidai-[0-9A-Fa-f]{16}$")


async def handle_key_input(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Nhận chuỗi Key, kích hoạt nếu hợp lệ."""
    user    = update.effective_user
    user_id = user.id
    text    = (update.message.text or "").strip()

    # Validate định dạng key
    if not KEY_RE.match(text):
        await update.message.reply_text(
            "⚠️ *Định dạng Key không đúng!*\n\n"
            "Key phải có dạng: `BoKietvidai-XXXXXXXXXXXXXXXX`\n"
            "Vui lòng kiểm tra lại và gửi Key:",
            parse_mode=ParseMode.MARKDOWN,
        )
        return STATE_WAITING_KEY

    result = db_activate_key(text, user_id)

    if result["ok"]:
        expire_str = _fmt_expire(result.get("expires_at"))
        await update.message.reply_text(
            f"✅ *Kích hoạt thành công!*\n\n"
            f"🔑 Key: `{text}`\n"
            f"⏳ Hết hạn: `{expire_str}`\n\n"
            f"🎉 Bạn có thể dùng *Phân tích MD5* ngay bây giờ!",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_menu_keyboard(user_id),
        )
        # Thông báo cho Admin
        await _notify_admin_key_activated(context, user, text, expire_str)
    else:
        await update.message.reply_text(
            f"{result['msg']}\n\nVui lòng kiểm tra lại Key hoặc liên hệ Admin.",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=main_menu_keyboard(user_id),
        )

    return ConversationHandler.END


async def _notify_admin_key_activated(
    context: ContextTypes.DEFAULT_TYPE,
    user,
    key_code: str,
    expire_str: str,
) -> None:
    """Gửi thông báo cho Admin khi có User kích hoạt Key."""
    try:
        username = f"@{user.username}" if user.username else "_(không có username)_"
        msg = (
            f"🔔 *Thông báo kích hoạt Key*\n\n"
            f"👤 User: {user.full_name} ({username})\n"
            f"🆔 ID: `{user.id}`\n"
            f"🔑 Key: `{key_code}`\n"
            f"⏳ Hết hạn: `{expire_str}`\n"
            f"🕐 Lúc: `{datetime.now().strftime('%d/%m/%Y %H:%M:%S')}`"
        )
        await context.bot.send_message(
            chat_id=ADMIN_ID,
            text=msg,
            parse_mode=ParseMode.MARKDOWN,
        )
    except Exception as e:
        # Không crash bot nếu Admin block bot hoặc lỗi gửi tin
        logger.warning("Không thể thông báo Admin: %s", e)


# ──────── Fallback: tin nhắn không mong đợi ────────

async def handle_unexpected(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Xử lý tin nhắn không thuộc ConversationHandler."""
    await update.message.reply_text(
        "👋 Dùng lệnh /start để mở menu.",
        reply_markup=main_menu_keyboard(update.effective_user.id),
    )


# ──────── Lệnh /admin – tóm tắt nhanh cho Admin ────────

async def cmd_admin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Lệnh /admin – chỉ Admin mới dùng được."""
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        await update.message.reply_text("🚫 Không có quyền!")
        return

    with sqlite3.connect(DB_PATH) as conn:
        total_keys    = conn.execute("SELECT COUNT(*) FROM keys").fetchone()[0]
        activated     = conn.execute("SELECT COUNT(*) FROM keys WHERE activated_by IS NOT NULL").fetchone()[0]
        total_users   = conn.execute("SELECT COUNT(*) FROM users WHERE active_key IS NOT NULL").fetchone()[0]
        now           = time.time()
        active_users  = conn.execute(
            "SELECT COUNT(*) FROM users WHERE active_key IS NOT NULL AND (key_expires_at IS NULL OR key_expires_at > ?)",
            (now,),
        ).fetchone()[0]

    await update.message.reply_text(
        f"📊 *Thống kê hệ thống*\n\n"
        f"🔑 Tổng Key đã tạo:      `{total_keys}`\n"
        f"✅ Key đã kích hoạt:     `{activated}`\n"
        f"👥 Tổng User có Key:     `{total_users}`\n"
        f"🟢 User đang hoạt động:  `{active_users}`\n\n"
        f"🕐 Cập nhật lúc: `{datetime.now().strftime('%d/%m/%Y %H:%M:%S')}`",
        parse_mode=ParseMode.MARKDOWN,
        reply_markup=main_menu_keyboard(user_id),
    )


# ──────────────────────────────────────────────────────────────
# 9. KHỞI ĐỘNG BOT
# ──────────────────────────────────────────────────────────────

def _validate_config() -> bool:
    """Kiểm tra cấu hình trước khi chạy."""
    ok = True
    if TELEGRAM_BOT_TOKEN == "YOUR_BOT_TOKEN_HERE":
        logger.error("❌ Chưa điền TELEGRAM_BOT_TOKEN!")
        ok = False
    if not isinstance(ADMIN_ID, int) or ADMIN_ID == 123456789:
        logger.error("❌ Chưa điền ADMIN_ID hợp lệ (phải là số nguyên Telegram User ID)!")
        ok = False
    return ok


def main() -> None:
    if not _validate_config():
        sys.exit(1)

    db_init()

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    # ConversationHandler chính
    conv = ConversationHandler(
        entry_points=[
            CommandHandler("start",  cmd_start),
            CallbackQueryHandler(cb_menu_analyze,   pattern="^menu_analyze$"),
            CallbackQueryHandler(cb_menu_enterkey,  pattern="^menu_enterkey$"),
            CallbackQueryHandler(cb_menu_createkey, pattern="^menu_createkey$"),
            CallbackQueryHandler(cb_menu_back,      pattern="^menu_back$"),
            CallbackQueryHandler(cb_tier_selected,  pattern="^tier_"),
        ],
        states={
            STATE_WAITING_MD5: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_md5_input),
                # Cho phép bấm nút menu trong khi đang chờ MD5
                CallbackQueryHandler(cb_menu_analyze,   pattern="^menu_analyze$"),
                CallbackQueryHandler(cb_menu_enterkey,  pattern="^menu_enterkey$"),
                CallbackQueryHandler(cb_menu_createkey, pattern="^menu_createkey$"),
                CallbackQueryHandler(cb_menu_back,      pattern="^menu_back$"),
            ],
            STATE_WAITING_KEY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_key_input),
                CallbackQueryHandler(cb_menu_back, pattern="^menu_back$"),
            ],
            STATE_WAITING_TIER: [
                CallbackQueryHandler(cb_tier_selected, pattern="^tier_"),
                CallbackQueryHandler(cb_menu_back,     pattern="^menu_back$"),
            ],
        },
        fallbacks=[
            CommandHandler("start", cmd_start),
            CommandHandler("admin", cmd_admin),
        ],
        per_message=False,
    )

    app.add_handler(conv)
    app.add_handler(CommandHandler("admin", cmd_admin))
    app.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE,
        handle_unexpected,
    ))

    # Đặt commands hiển thị trong Telegram
    async def post_init(app: Application) -> None:
        await app.bot.set_my_commands([
            BotCommand("start", "Mở menu chính"),
            BotCommand("admin", "Thống kê (Admin only)"),
        ])
        logger.info("✅ Bot đã khởi động! ADMIN_ID=%d", ADMIN_ID)

    app.post_init = post_init

    logger.info("🚀 Đang khởi động Bot...")
    app.run_polling(
        allowed_updates=Update.ALL_TYPES,
        drop_pending_updates=True,  # Bỏ qua tin nhắn cũ khi restart
    )


if __name__ == "__main__":
    main()
