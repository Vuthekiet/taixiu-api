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
const TELEGRAM_CHAT_ID = "8284419367"; 

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
    telegramSent:  { type: Boolean, default: false },
    timestamp:     { type: Date, default: Date.now }
});

const brainSchema = new mongoose.Schema({
    formulaName:   { type: String, unique: true },
    winCount:      { type: Number, default: 0 },
    loseCount:     { type: Number, default: 0 },
    lastResults:   [Boolean], 
    weight:        { type: Number, default: 1.0 }
});

const Session = mongoose.model('Session', sessionSchema);
const Brain = mongoose.model('Brain', brainSchema);

app.use(cors());
app.use(express.json());

// ==========================================
// BỘ CÔNG THỨC DỰ ĐOÁN
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
    static async learnFromPast(phien, ketQua) {
        const session = await Session.findOne({ phien });
        if (session && session.duDoan && session.isCorrect === undefined) {
            const isCorrect = session.duDoan === ketQua;
            await Session.updateOne({ phien }, { $set: { ketQua, isCorrect } });
            
            const brain = await Brain.findOne({ formulaName: session.formulaUsed });
            if (brain) {
                await Brain.updateOne({ formulaName: session.formulaUsed }, {
                    <LaTex>$inc: isCorrect ? { winCount: 1 } : { loseCount: 1 },
                    $</LaTex>push: { lastResults: { <LaTex>$each: [isCorrect], $</LaTex>slice: -20 } }
                });
            }
        }
    }

    static async getBestFormula(sessions) {
        const brains = await Brain.find();
        let bestFormula = formulas[0];
        let maxScore = -1;

        for (const formula of formulas) {
            const brain = brains.find(b => b.formulaName === formula.id) || { lastResults: [] };
            const recentWins = brain.lastResults.filter(r => r === true).length;
            const winRate = brain.lastResults.length > 0 ? recentWins / brain.lastResults.length : 0.5;
            
            let currentScore = 0;
            const len = sessions.length;
            for (let j = len - 5; j < len; j++) {
                try {
                    const realRes = sessions[j].resultTruyenThong === "TAI" ? "Tài" : "Xỉu";
                    if (formula.fn(sessions, j) === realRes) currentScore++;
                } catch (e) {}
            }

            const totalScore = (winRate * 5) + (currentScore * 1.5);
            if (totalScore > maxScore) {
                maxScore = totalScore;
                bestFormula = formula;
            }
        }
        return { formula: bestFormula, score: maxScore };
    }
}

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

        const sessions = data.list.reverse(); 
        const latest = sessions[sessions.length - 1];
        const phienVuaRa = latest.id;
        const ketQua = latest.resultTruyenThong === "TAI" ? "Tài" : "Xỉu";

        await AILearning.learnFromPast(phienVuaRa, ketQua);

        const { formula, score } = await AILearning.getBestFormula(sessions);
        const prediction = formula.fn(sessions, sessions.length);
        const phienMoi = phienVuaRa + 1;

        await Session.updateOne(
            { phien: phienMoi },
            { $set: { duDoan: prediction, formulaUsed: formula.id, hashId: latest._id } },
            { upsert: true }
        );

        const checkSent = await Session.findOne({ phien: phienMoi, telegramSent: true });
        if (!checkSent) {
            const msg = `
🤖 *AI SELF-LEARNING V9*
━━━━━━━━━━━━━━━━
🎲 Phiên vừa ra: *<LaTex>${phienVuaRa}*
✅ Kết quả: *$</LaTex>{ketQua}* (<LaTex>${latest.point}đ)
━━━━━━━━━━━━━━━━
🔮 Dự đoán phiên: *$</LaTex>{phienMoi}*
🔥 Đặt cược: *<LaTex>${prediction.toUpperCase()}*
🧠 Logic: \`$</LaTex>{formula.name}\`
📈 Độ tin cậy: \`<LaTex>${Math.min(95, (score * 8)).toFixed(1)}%\`
━━━━━━━━━━━━━━━━
📊 *Dữ liệu đã học: $</LaTex>{await Session.countDocuments({ isCorrect: { <LaTex>$ne: null } })} phiên*
            `;
            await sendTelegram(msg);
            await Session.updateOne({ phien: phienMoi }, { $</LaTex>set: { telegramSent: true } });
        }

        res.json({
            status: "AI Learning Active",
            phien_vua_ra: phienVuaRa,
            ket_qua: ketQua,
            du_doan_moi: prediction,
            phien_moi: phienMoi,
            logic: formula.name,
            winrate_ai: (await Session.countDocuments({ isCorrect: true }) / (await Session.countDocuments({ isCorrect: { <LaTex>$ne: null } }) || 1) * 100).toFixed(1) + "%"
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

setInterval(async () => {
    try { await axios.get(`http://localhost:$</LaTex>{port}/api/taixiu`); } catch (e) {}
}, 30000);

app.listen(port, () => console.log(`🚀 AI v9 running on port ${port}`));
