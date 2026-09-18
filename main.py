import os
import sqlite3
import secrets
import hashlib
import datetime
import threading
import nest_asyncio
from flask import Flask, jsonify
from telegram import (
    Bot,
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    ReplyKeyboardRemove,
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# -------------------- CẤU HÌNH CỨNG BUỘC --------------------
BOT_TOKEN = "8671164366:AAER5O_pyBWG_hhG8IUortHYX5oJ8bzMAWM"          # <-- Thay bằng token thực của bạn
ADMIN_ID =   8284419367                # <-- Thay bằng ID admin thực của bạn

# -------------------- CẤU HÌNH DATABASE --------------------
DB_PATH = "keys.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS keys (
            key TEXT PRIMARY KEY,
            user_id INTEGER,
            expires_at INTEGER   -- timestamp epoch
        )
        """
    )
    conn.commit()
    conn.close()

def add_key(user_id: int, key: str, ttl_seconds: int):
    expires = int(datetime.datetime.utcnow().timestamp()) + ttl_seconds
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "INSERT OR REPLACE INTO keys (key, user_id, expires_at) VALUES (?, ?, ?)",
        (key, user_id, expires),
    )
    conn.commit()
    conn.close()

def get_key(user_id: int):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur = cur.execute(
        "SELECT key, expires_at FROM keys WHERE user_id = ?", (user_id,)
    )
    row = cur.fetchone()
    conn.close()
    return row  # (key, expires_at) or None

def is_key_valid(user_id: int, key: str):
    data = get_key(user_id)
    if not data:
        return False
    stored_key, expires = data
    now = int(datetime.datetime.utcnow().timestamp())
    return stored_key == key and now < expires

# -------------------- LOGIC MD5 --------------------
def predict_score(md5_str: str) -> str:
    """
    Thuật toán mẫu: tính sum của các byte trong MD5,
    cộng thêm timestamp hiện tại, rồi chia để đưa vào 2 khoảng.
    """
    ts = int(datetime.datetime.utcnow().timestamp())
    total = sum(bytearray.fromhex(md5_str)) + ts
    score = total % 20 + 1  # 1‑20
    if score <= 10:
        return f"XOÀI ({score} điểm)"
    else:
        return f"TÁO ({score} điểm)"

# -------------------- FLASK APP --------------------
app = Flask(__name__)

@app.route("/", methods=["GET"])
def health():
    return jsonify({"status": "OK"}), 200

# -------------------- TELEGRAM BOT --------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    is_admin = user_id == ADMIN_ID

    keyboard = [
        [InlineKeyboardButton("1️⃣ Phân tích MD5", callback_data="md5")],
        [InlineKeyboardButton("2️⃣ Nhập Key", callback_data="enter_key")],
    ]
    if is_admin:
        keyboard.append(
            [InlineKeyboardButton("3️⃣ Tạo Key (Admin)", callback_data="create_key")]
        )

    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(
        "Chào mừng! Chọn một chức năng:",
        reply_markup=reply_markup,
    )

# -------------------- CALLBACK HANDLERS --------------------
async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id

    if query.data == "md5":
        # Kiểm tra key
        key_data = get_key(user_id)
        if not key_data:
            await query.edit_message_text(
                "Bạn chưa có key. Vui lòng nhập key bằng lệnh /start → Nhập Key."
            )
            return
        await query.edit_message_text("Vui lòng gửi chuỗi MD5 (32 ký tự).")
        context.user_data["awaiting_md5"] = True

    elif query.data == "enter_key":
        await query.edit_message_text("Vui lòng gửi key của bạn.")
        context.user_data["awaiting_key"] = True

    elif query.data == "create_key" and user_id == ADMIN_ID:
        # Menu thời hạn
        keyboard = [
            [
                InlineKeyboardButton("1 ngày", callback_data="ttl_1d"),
                InlineKeyboardButton("3 ngày", callback_data="ttl_3d"),
            ],
            [
                InlineKeyboardButton("7 ngày", callback_data="ttl_7d"),
                InlineKeyboardButton("1 tháng", callback_data="ttl_30d"),
            ],
            [
                InlineKeyboardButton("1 năm", callback_data="ttl_365d"),
                InlineKeyboardButton("Vĩnh viễn", callback_data="ttl_perm"),
            ],
        ]
        await query.edit_message_text(
            "Chọn thời hạn cho key mới:",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    else:
        await query.edit_message_text("Lệnh không hợp lệ.")

async def ttl_selection(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    ttl_map = {
        "ttl_1d": 86400,
        "ttl_3d": 86400 * 3,
        "ttl_7d": 86400 * 7,
        "ttl_30d": 86400 * 30,
        "ttl_365d": 86400 * 365,
        "ttl_perm": 60 * 60 * 24 * 365 * 100,  # 100 năm ≈ vĩnh viễn
    }
    ttl = ttl_map.get(query.data, 86400)
    new_key = "BoKietvidai-" + secrets.token_urlsafe(16)
    add_key(ADMIN_ID, new_key, ttl)
    await query.edit_message_text(
        f"✅ Đã tạo key:\n`{new_key}`\nThời hạn: {query.data.split('_')[1]}",
        parse_mode="Markdown",
    )

# -------------------- MESSAGE HANDLERS --------------------
async def text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    text = update.message.text.strip()

    # Nhập key
    if context.user_data.get("awaiting_key"):
        # Lưu key
        add_key(user_id, text, 86400 * 30)  # Mặc định 30 ngày
        await update.message.reply_text("✅ Key đã được lưu, hiệu lực 30 ngày.")
        context.user_data["awaiting_key"] = False
        return

    # Nhập MD5
    if context.user_data.get("awaiting_md5"):
        if len(text) != 32 or not all(c in "0123456789abcdefABCDEF" for c in text):
            await update.message.reply_text(
                "❌ MD5 không hợp lệ. Vui lòng gửi lại chuỗi 32 ký tự hex."
            )
            return
        # Kiểm tra key hợp lệ
        key_data = get_key(user_id)
        if not key_data or not is_key_valid(user_id, key_data[0]):
            await update.message.reply_text(
                "❌ Key không hợp lệ hoặc đã hết hạn. Vui lòng nhập key mới."
            )
            context.user_data["awaiting_md5"] = False
            return

        # Dự đoán
        result = predict_score(text)
        keyboard = [
            [
                InlineKeyboardButton("✅ ĐÚNG", callback_data="vote_good"),
                InlineKeyboardButton("❌ SAI", callback_data="vote_bad"),
            ]
        ]
        await update.message.reply_text(
            f"Kết quả dự đoán: *{result}*",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode="Markdown",
        )
        context.user_data["awaiting_md5"] = False
        return

    # Nếu không phải trường hợp trên
    await update.message.reply_text(
        "🤖 Đừng biết làm gì? Dùng /start để xem menu."
    )

# -------------------- MAIN STARTUP --------------------
def run_bot():
    nest_asyncio.apply()
    application = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .concurrent_updates(True)
        .build()
    )

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CallbackQueryHandler(button_handler, pattern="^(md5|enter_key|create_key)$"))
    application.add_handler(CallbackQueryHandler(ttl_selection, pattern="^ttl_"))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_handler))

    # Bắt đầu polling trong thread daemon
    application.run_polling()

if __name__ == "__main__":
    init_db()

    # Khởi chạy bot trong daemon thread
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()

    # Khởi chạy Flask (Render sẽ gọi qua gunicorn)
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
