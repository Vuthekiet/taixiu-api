const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// CẤU HÌNH & KẾT NỐI
// ==========================================
const MONGODB_URI = "mongodb+srv://Bolakiettrumtx:Kiet280911@cluster0.izuwm8b.mongodb.net/taixiuDB?retryWrites=true&w=majority";
const TELEGRAM_TOKEN = "7934446128:AAHio5BnyLQXEtwpwFSaW5azYPxhuYjAFmY";
const TELEGRAM_CHAT_ID = "8284419367"; // Bạn cần lấy Chat ID của mình, mặc định tôi để ID mẫu, bạn có thể thay đổi

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ AI Database Connected!'))
  .catch(err => console.error('❌ DB Error:', err));

// ==========================================
// SCHEMA - LƯU TRỮ ĐỂ AI HỌC
// ==========================================
const sessionSchema = new mongoose.Schema({
    phien:         { type: Number, required: true, unique: true },
    ketQua:        { type: String },
    tong:          { type: Number },
    dices:         [Number],
    hashId:        { type: String },
    duDoan:        { type: String },
    formulaUsed:   { type: String },
    isCorrect:     { type: Boolean },
    timestamp:     { type: Date, default: Date.now }
});

// Schema để lưu "trí thông minh" của từng công thức
const brainSchema = new mongoose.Schema({
    formulaName:   { type: String, unique: true },
    winCount:      { type: Number, default: 0 },
    loseCount:     { type: Number, default: 0 },
    lastResults:   [Boolean], // Lưu 20 kết quả gần nhất để tính phong độ
    weight:        { type: Number, default: 1.0 } // Trọng số ưu tiên
});

const Session = mongoose.model('Session', sessionSchema);
const Brain = mongoose.model('Brain', brainSchema);

app.use(cors());
app.use(express.json());

// ==========================================
// BỘ CÔNG THỨC DỰ ĐOÁN (CƠ SỞ DỮ LIỆU CỦA AI)
// ==========================================
const formulas = [
    { id: "hash_parity", name: "Hash Parity", fn: (data, i) => {
        const target = data[i] || data[i-1];
        return parseInt(target._id.slice(-2), 16) % 2 === 0 ? "Tài" : "Xỉu";
    }},
    { id: "point_parity", name: "Point Parity", fn: (data, i) => data[i-1].point % 2 === 0 ? "Tài" : "Xỉu" },
    { id: "bridge_11", name: "Cầu 1-1", fn: (data, i) => data[i-1].resultTruyenThong === "TAI" ? "Xỉu" : "Tài" },
    { id: "sum_prev_2", name: "Tổng 2 Phiên", fn: (data, i) => (data[i-1].point + data[i-2].point) % 2 === 0 ? "Tài" : "Xỉu" },
    { id: "md5_standard", name: "MD5 Chuẩn", fn: (data, i) => (data[i-1].dices[0] + data[i-1].dices[1] + data[i-1].dices[2]) % 2 === 0 ? "Tài" : "Xỉu" },
    { id: "hash_bridge", name: "Cầu Hash", fn: (data, i) => {
        const target = data[i] || data[i-1];
        return (parseInt(target._id.slice(-2), 16) + data[i-1].point) % 2 === 0 ? "Tài" : "Xỉu";
    }},
    { id: "trend_inv", name: "Đảo Trend", fn: (data, i) => data[i-1].point > 10 ? "Xỉu" : "Tài" }
];

// ==========================================
// MODULE TELEGRAM
// ==========================================
async function sendTelegram(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        console.error("Telegram Error:", e.message);
    }
}

// ==========================================
// HỆ THỐNG TỰ HỌC (LEARNING ENGINE)
// ==========================================
class AILearning {
    // Cập nhật kết quả và cho AI học từ lỗi sai
    static async learnFromPast(phien, ketQua) {
        const session = await Session.findOne({ phien });
        if (session && session.duDoan) {
            const isCorrect = session.duDoan === ketQua;
            await Session.updateOne({ phien }, { $set: { ketQua, isCorrect } });
            
            // Cập nhật Brain cho công thức đã dùng
            const brain = await Brain.findOne({ formulaName: session.formulaUsed });
            if (brain) {
                const update = {
                    $inc: isCorrect ? { winCount: 1 } : { loseCount: 1 },
                    $push: { lastResults: { $each: [isCorrect], $slice: -20 } }
                };
                await Brain.updateOne({ formulaName: session.formulaUsed }, update);
            }
        }
    }

    // Chọn công thức thông minh nhất dựa trên lịch sử dài hạn
    static async getBestFormula(sessions) {
        const brains = await Brain.find();
        let bestFormula = formulas[0];
        let maxScore = -1;

        for (const formula of formulas) {
            const brain = brains.find(b => b.formulaName === formula.id) || { winCount: 0, loseCount: 0, lastResults: [] };
            
            // Tính điểm phong độ (winrate 20 phiên gần nhất)
            const recentWins = brain.lastResults.filter(r => r === true).length;
            const recentTotal = brain.lastResults.length;
            const winRate = recentTotal > 0 ? recentWins / recentTotal : 0.5;
            
            // Tính điểm thử nghiệm trên 5 phiên hiện tại của API
            let currentScore = 0;
            const len = sessions.length;
            for (let j = len - 5; j < len; j++) {
                try {
                    if (formula.fn(sessions, j) === sessions[j].resultTruyenThong) currentScore++;
                } catch (e) {}
            }

            // Điểm tổng hợp = (Phong độ dài hạn * 0.4) + (Đúng ngắn hạn * 0.6)
            const totalScore = (winRate * 4) + (currentScore * 1.2);
            
            if (totalScore > maxScore) {
                maxScore = totalScore;
                bestFormula = formula;
            }
        }
        return { formula: bestFormula, score: maxScore };
    }
}

// Khởi tạo Brain nếu chưa có
async function initBrain() {
    for (const f of formulas) {
        await Brain.updateOne({ formulaName: f.id }, { $setOnInsert: { winCount: 0, loseCount: 0, lastResults: [] } }, { upsert: true });
    }
}
initBrain();

// ==========================================
// API CHÍNH
// ==========================================
app.get('/api/taixiu', async (req, res) => {
    try {
        const apiUrl = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2';
        const response = await axios.get(apiUrl);
        const data = response.data;
        
        if (!data?.list) throw new Error("API Error");

        const sessions = data.list.reverse(); // Cũ -> Mới
        const latest = sessions[sessions.length - 1];
        const phienVuaRa = latest.id;
        const ketQua = latest.resultTruyenThong === "TAI" ? "Tài" : "Xỉu";

        // 1. Cho AI học từ phiên vừa ra
        await AILearning.learnFromPast(phienVuaRa, ketQua);

        // 2. Dự đoán phiên tiếp theo
        const { formula, score } = await AILearning.getBestFormula(sessions);
        const prediction = formula.fn(sessions, sessions.length);
        const phienMoi = phienVuaRa + 1;

        // 3. Lưu dự đoán vào Session để phiên sau đối chiếu học tập
        await Session.updateOne(
            { phien: phienMoi },
            { $set: { duDoan: prediction, formulaUsed: formula.id, hashId: latest._id } },
            { upsert: true }
        );

        // 4. Gửi Telegram nếu là phiên mới
        const lastSentPhien = await Session.findOne({ phien: phienMoi, telegramSent: true });
        if (!lastSentPhien) {
            const msg = `
🤖 *AI SELF-LEARNING V9*
━━━━━━━━━━━━━━━━
🎲 Phiên vừa ra: *${phienVuaRa}*
✅ Kết quả: *${ketQua}* (${latest.point} điểm)
━━━━━━━━━━━━━━━━
🔮 Dự đoán phiên: *${phienMoi}*
🔥 Đặt cược: *${prediction.toUpperCase()}*
🧠 Chiến thuật: \`${formula.name}\`
📈 Độ tin cậy: \`${(score * 10).toFixed(1)}%\`
━━━━━━━━━━━━━━━━
📊 *AI đang học từ ${await Session.countDocuments({ isCorrect: { $ne: null } })} phiên dữ liệu*
            `;
            await sendTelegram(msg);
            await Session.updateOne({ phien: phienMoi }, { $set: { telegramSent: true } });
        }

        res.json({
            status: "AI Learning Active",
            phien_vua_ra: phienVuaRa,
            ket_qua: ketQua,
            du_doan_moi: prediction,
            phien_moi: phienMoi,
            logic: formula.name
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Chạy chế độ Auto-Update mỗi 30 giây để AI tự học 24/24
setInterval(async () => {
    try {
        await axios.get(`http://localhost:${port}/api/taixiu`);
    } catch (e) {}
}, 30000);

app.listen(port, () => console.log(`🚀 AI Self-Learning System v9 running on port ${port}`));
