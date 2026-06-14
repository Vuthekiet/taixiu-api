import requests
import time
import json
from pymongo import MongoClient
from datetime import datetime

# ==========================================
# CẤU HÌNH
# ==========================================
MONGODB_URI = "mongodb+srv://Bolakiettrumtx:Kiet280911@cluster0.izuwm8b.mongodb.net/taixiuDB?retryWrites=true&w=majority"
TELEGRAM_TOKEN = "7934446128:AAHio5BnyLQXEtwpwFSaW5azYPxhuYjAFmY"
TELEGRAM_CHAT_ID = "8284419367"
API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2"

client = MongoClient(MONGODB_URI)
db = client['taixiuDB']
sessions_col = db['sessions']
brains_col = db['brains']

# ==========================================
# CÁC CÔNG THỨC DỰ ĐOÁN (AI CORE)
# ==========================================
def get_prediction(formula_id, sessions, i):
    try:
        # i là index của phiên cần dự đoán
        # sessions là list đã đảo ngược (cũ -> mới)
        prev = sessions[i-1]
        
        if formula_id == "hash_parity":
            target = sessions[i] if i < len(sessions) else sessions[i-1]
            return "Tài" if int(target['_id'][-2:], 16) % 2 == 0 else "Xỉu"
        
        elif formula_id == "point_parity":
            return "Tài" if prev['point'] % 2 == 0 else "Xỉu"
            
        elif formula_id == "bridge_11":
            return "Xỉu" if prev['resultTruyenThong'] == "TAI" else "Tài"
            
        elif formula_id == "sum_prev_2":
            prev2 = sessions[i-2]
            return "Tài" if (prev['point'] + prev2['point']) % 2 == 0 else "Xỉu"
            
        elif formula_id == "md5_standard":
            return "Tài" if sum(prev['dices']) % 2 == 0 else "Xỉu"
            
        elif formula_id == "hash_bridge":
            target = sessions[i] if i < len(sessions) else sessions[i-1]
            return "Tài" if (int(target['_id'][-2:], 16) + prev['point']) % 2 == 0 else "Xỉu"
            
        elif formula_id == "trend_inv":
            return "Xỉu" if prev['point'] > 10 else "Tài"
            
    except:
        return "Tài" # Default
    return "Tài"

FORMULAS = [
    {"id": "hash_parity", "name": "Hash Parity"},
    {"id": "point_parity", "name": "Point Parity"},
    {"id": "bridge_11", "name": "Cầu 1-1"},
    {"id": "sum_prev_2", "name": "Tổng 2 Phiên"},
    {"id": "md5_standard", "name": "MD5 Chuẩn"},
    {"id": "hash_bridge", "name": "Cầu Hash"},
    {"id": "trend_inv", "name": "Đảo Trend"}
]

# ==========================================
# HỆ THỐNG AI
# ==========================================
def send_telegram(message):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    try:
        requests.post(url, json={
            "chat_id": TELEGRAM_CHAT_ID,
            "text": message,
            "parse_mode": "Markdown"
        }, timeout=10)
    except Exception as e:
        print(f"Telegram Error: {e}")

def run_ai_logic(sessions):
    # Lấy dữ liệu Brain để tính trọng số
    brains = list(brains_col.find())
    tai_votes = 0
    xiu_votes = 0
    details = []

    for f in FORMULAS:
        brain = next((b for b in brains if b['formulaName'] == f['id']), None)
        if not brain:
            win_rate = 0.5
            brains_col.insert_one({"formulaName": f['id'], "winCount": 0, "loseCount": 0, "lastResults": []})
        else:
            last_res = brain.get('lastResults', [])
            win_rate = last_res.count(True) / len(last_res) if last_res else 0.5
        
        # Trọng số bình phương để ưu tiên cực độ cái đang thắng
        weight = win_rate ** 2
        pred = get_prediction(f['id'], sessions, len(sessions))
        
        if pred == "Tài": tai_votes += weight
        else xiu_votes += weight
        
        details.append(f"• {f['name']}: {pred} ({int(win_rate*100)}%)")

    final_pred = "Tài" if tai_votes >= xiu_votes else "Xỉu"
    confidence = (max(tai_votes, xiu_votes) / (tai_votes + xiu_votes)) * 100 if (tai_votes + xiu_votes) > 0 else 50
    
    return final_pred, min(98.5, confidence), "\n".join(details)

def learn_and_update(phien_id, real_result):
    # Tìm dự đoán của phiên này để đối chiếu
    session = sessions_col.find_one({"phien": phien_id})
    if session and "duDoan" in session and "isCorrect" not in session:
        is_correct = session['duDoan'] == real_result
        sessions_col.update_one({"phien": phien_id}, {"$set": {"ketQua": real_result, "isCorrect": is_correct}})
        
        # Cập nhật Brain cho TẤT CẢ công thức để AI biết cái nào đang đúng
        # (Lưu ý: Đoạn này quan trọng để AI "học")
        # Chúng ta giả lập lại dự đoán của từng cái để học
        # ... (phần này sẽ chạy trong vòng lặp chính)

# ==========================================
# VÒNG LẶP CHÍNH (24/24)
# ==========================================
def main():
    print("🚀 AI Worker v9.1 started...")
    last_processed_phien = 0

    while True:
        try:
            response = requests.get(API_URL, timeout=10)
            data = response.json()
            if 'list' not in data: continue

            sessions = data['list'][::-1] # Cũ -> Mới
            latest = sessions[-1]
            phien_ht = latest['id']

            if phien_ht > last_processed_phien:
                real_res = "Tài" if latest['resultTruyenThong'] == "TAI" else "Xỉu"
                
                # 1. AI Học từ phiên vừa kết thúc
                learn_and_update(phien_ht, real_res)
                
                # Cập nhật Brain cho từng công thức
                for f in FORMULAS:
                    pred_f = get_prediction(f['id'], sessions[:-1], len(sessions)-1)
                    is_f_correct = pred_f == real_res
                    brains_col.update_one(
                        {"formulaName": f['id']},
                        {
                            "$push": {"lastResults": {"$each": [is_f_correct], "$slice": -30}}
                        }
                    )

                # 2. Dự đoán phiên mới
                pred, conf, details = run_ai_logic(sessions)
                phien_moi = phien_ht + 1
                
                # Lưu dự đoán vào DB
                sessions_col.update_one(
                    {"phien": phien_moi},
                    {"$set": {"duDoan": pred, "timestamp": datetime.now()}},
                    upsert=True
                )

                # 3. Gửi Telegram
                msg = f"🚀 *AI WORKER V9.1 - DỰ ĐOÁN*\n" \
                      f"━━━━━━━━━━━━━━━━\n" \
                      f"🎲 Vừa ra: *{phien_ht}* ➔ *{real_res.upper()}*\n" \
                      f"━━━━━━━━━━━━━━━━\n" \
                      f"🔮 Phiên tới: *{phien_moi}*\n" \
                      f"🔥 Đặt cược: *{pred.upper()}*\n" \
                      f"📈 Độ tin cậy: `{conf:.1f}%`\n\n" \
                      f"📊 *Phân tích AI:*\n{details}\n" \
                      f"━━━━━━━━━━━━━━━━\n" \
                      f"🤖 *AI đang học từ {sessions_col.count_documents({'isCorrect': {'$ne': None}})} phiên*"
                
                send_telegram(msg)
                last_processed_phien = phien_ht
                print(f"✅ Processed phien {phien_ht}, Predicted {phien_moi}: {pred}")

        except Exception as e:
            print(f"Loop Error: {e}")
        
        time.sleep(10) # Kiểm tra mỗi 10 giây

if __name__ == "__main__":
    main()
