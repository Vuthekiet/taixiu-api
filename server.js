const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// KẾT NỐI MONGODB
// ==========================================
const MONGODB_URI = "mongodb+srv://Bolakiettrumtx:Kiet280911@cluster0.izuwm8b.mongodb.net/taixiuDB?retryWrites=true&w=majority";
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ AI v11.0 Dice Master - Database Connected!"))
  .catch(err => console.error("❌ DB Error:", err));

// ==========================================
// SCHEMA
// ==========================================
const historySchema = new mongoose.Schema({
    phien:         { type: Number, required: true, unique: true },
    ketQua:        { type: String },
    tong:          { type: Number },
    dices:         [Number],
    duDoan:        { type: String },
    isCorrect:     { type: Boolean },
    hashId:        { type: String },
    timestamp:     { type: Date, default: Date.now }
});
const History = mongoose.model("History", historySchema);

app.use(cors());
app.use(express.json());

// ==========================================
// AI CORE: THUẬT TOÁN DỰ ĐOÁN ĐIỂM RƠI & BIẾN ĐỘNG XÚC XẮC
// ==========================================

function getDiceAlgorithm(sessions) {
    if (!sessions || sessions.length < 15) {
        return { prediction: "Tài", confidence: "50.0", logic: "Đang lấy dữ liệu lịch sử..." };
    }

    // Chuyển đổi dữ liệu sang dạng dễ xử lý
    const h = sessions.map(s => {
        const sum = (s.dice1 || 0) + (s.dice2 || 0) + (s.dice3 || 0);
        if (sum === 0 && s.resultTruyenThong) return s.resultTruyenThong === 'TAI' ? 1 : 0;
        return sum > 10 ? 1 : 0;
    });

    const rawH = sessions;
    let curStreak = 0; 
    for(let i=0; i<h.length; i++) { 
        if(h[i] === h[0]) curStreak++; 
        else break; 
    }

    let finalPred = -1;
    let logicMsg = "";
    let confBase = 70;

    // 1. VIP 14: GAUSSIAN NOISE FILTER (Lọc nhiễu động điểm số)
    let gaussianPred = -1;
    let sums = [];
    for(let i=0; i<Math.min(15, rawH.length); i++) {
        let s = (rawH[i].dice1||0) + (rawH[i].dice2||0) + (rawH[i].dice3||0);
        if(s > 0) sums.push(s);
    }
    
    if (sums.length >= 10) {
        let mean = sums.reduce((a, b) => a + b, 0) / sums.length;
        let variance = sums.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / sums.length;
        let stdDev = Math.sqrt(variance);
        
        if (stdDev < 1.5 && curStreak >= 3) {
            gaussianPred = h[0] === 1 ? 0 : 1; // Đảo chiều khi điểm số quá ổn định
        } else if (stdDev > 5.0) {
            if (mean > 13) gaussianPred = 0; // Tài quá cao -> Xỉu
            else if (mean < 8) gaussianPred = 1; // Xỉu quá thấp -> Tài
        }
    }

    // 2. VIP 18: PHÂN TÍCH ĐIỂM RƠI DICE (Dice Fall Analysis)
    let diceFallPred = -1;
    if (rawH.length >= 10) {
        let lastDiceSets = rawH.slice(0, 10).map(x => (x.dice1||0) + (x.dice2||0) + (x.dice3||0));
        let isMonotonic = true;
        for(let i=0; i<lastDiceSets.length-1; i++) {
            if(Math.abs(lastDiceSets[i] - lastDiceSets[i+1]) > 2) {
                isMonotonic = false;
                break;
            }
        }
        if(isMonotonic && curStreak >= 2) {
            diceFallPred = h[0] === 1 ? 0 : 1; // Dự đoán gãy nhịp khi điểm rơi quá đều
        }
    }

    // 3. VIP 13: MARKOV CHAIN (Ma trận tầng chéo)
    let markovPred = -1;
    if (h.length >= 20) {
        let pattern = "" + h[2] + h[1] + h[0];
        let t1 = 0, t0 = 0;
        for (let i = 3; i < h.length - 1; i++) {
            if ("" + h[i+2] + h[i+1] + h[i] === pattern) {
                if (h[i-1] === 1) t1++; else t0++;
            }
        }
        if (t1 > t0 && t1 >= 2) markovPred = 1;
        else if (t0 > t1 && t0 >= 2) markovPred = 0;
    }

    // CÂY QUYẾT ĐỊNH ƯU TIÊN ĐIỂM RƠI
    if (diceFallPred !== -1) { 
        finalPred = diceFallPred; 
        logicMsg = "VIP 18 (ĐIỂM RƠI): CHUỖI ĐIỂM BIẾN ĐỘNG THẤP"; 
        confBase = 92; 
    } else if (gaussianPred !== -1) { 
        finalPred = gaussianPred; 
        logicMsg = "VIP 14 (GAUSSIAN): LỆCH CHUẨN ĐIỂM SỐ"; 
        confBase = 88; 
    } else if (markovPred !== -1) { 
        finalPred = markovPred; 
        logicMsg = "VIP 13 (MARKOV): MA TRẬN ĐIỂM LẶP"; 
        confBase = 85; 
    } else {
        // Mặc định dựa trên xu hướng gần nhất
        finalPred = h[0] === 1 ? 1 : 0;
        logicMsg = "XU HƯỚNG ĐIỂM HIỆN TẠI";
        confBase = 75;
    }

    return {
        prediction: finalPred === 1 ? "Tài" : "Xỉu",
        confidence: confBase.toFixed(1),
        logic: logicMsg
    };
}

// ==========================================
// API ENDPOINT
// ==========================================
app.get("/api/taixiu", async (req, res) => {
    try {
        const apiUrl = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2";
        const response = await axios.get(apiUrl);
        const data = response.data;
        
        if (!data?.list) throw new Error("API Error");

        // Dữ liệu từ API thường sắp xếp từ mới đến cũ
        const sessions = data.list; 
        const latest = sessions[0];
        const phienVuaRa = latest.id;
        
        let sum = (latest.dice1 || 0) + (latest.dice2 || 0) + (latest.dice3 || 0);
        let ketQua = sum > 10 ? "Tài" : "Xỉu";
        if (sum === 0 && latest.resultTruyenThong) ketQua = latest.resultTruyenThong === 'TAI' ? "Tài" : "Xỉu";

        // Cập nhật kết quả phiên vừa ra
        await History.updateOne(
            { phien: phienVuaRa },
            { $set: { ketQua, tong: sum, dices: [latest.dice1, latest.dice2, latest.dice3], hashId: latest._id } },
            { upsert: true }
        );

        // Dự đoán phiên mới
        const aiResult = getDiceAlgorithm(sessions);
        const phienMoi = phienVuaRa + 1;

        await History.updateOne(
            { phien: phienMoi },
            { $set: { duDoan: aiResult.prediction } },
            { upsert: true }
        );

        // Tính tỉ lệ thắng thực tế
        const recentHistory = await History.find({ ketQua: { $ne: null }, duDoan: { $ne: null } })
            .sort({ phien: -1 }).limit(10);
        const winCount = recentHistory.filter(h => h.ketQua === h.duDoan).length;

        res.json({
            Phien_HT: phienVuaRa,
            Ket_Qua: ketQua.toUpperCase(),
            Dices: [latest.dice1, latest.dice2, latest.dice3],
            Tong_Diem: sum,
            Phien_Du_Doan: phienMoi,
            DU_DOAN: aiResult.prediction.toUpperCase(),
            Do_Tin_Cay: `${aiResult.confidence}%`,
            WinRate_10_Phien: `${winCount}/10`,
            Logic_Info: aiResult.logic,
            Version: "11.0 Dice Master"
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(`🚀 AI v11.0 Dice Master running on port ${port}`)); 
