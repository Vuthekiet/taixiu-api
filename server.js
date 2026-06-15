const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const crypto = require("crypto");
const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// KẾT NỐI MONGODB
// ==========================================
const MONGODB_URI = "mongodb+srv://Bolakiettrumtx:Kiet280911@cluster0.izuwm8b.mongodb.net/taixiuDB?retryWrites=true&w=majority";
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ AI v12.0 MD5 Master - Database Connected!"))
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
// AI CORE: THUẬT TOÁN MD5 MASTER & DYNAMICS
// ==========================================

/**
 * Thuật toán dự đoán dựa trên sự biến động của chuỗi Hash MD5 và Điểm rơi xúc xắc
 */
function getMD5MasterAlgorithm(sessions) {
    if (!sessions || sessions.length < 20) {
        return { prediction: "Tài", confidence: "50.0", logic: "Đang thu thập dữ liệu MD5..." };
    }

    // Lấy 20 phiên gần nhất
    const h = sessions.slice(0, 20);
    
    // 1. Phân tích Hash MD5 (Dựa trên sự biến động của _id)
    // Mỗi _id trong MD5 đại diện cho một chuỗi hash duy nhất của phiên đó
    let hashEntropy = 0;
    for (let i = 0; i < 5; i++) {
        const currentHash = h[i]._id;
        const prevHash = h[i+1]._id;
        // Tính toán sự khác biệt giữa các byte cuối của hash
        const currentByte = parseInt(currentHash.slice(-2), 16);
        const prevByte = parseInt(prevHash.slice(-2), 16);
        hashEntropy += (currentByte ^ prevByte);
    }

    // 2. Phân tích Biến động Điểm số (Advanced Dynamics)
    const points = h.map(s => s.point);
    const results = h.map(s => s.resultTruyenThong === 'TAI' ? 1 : 0);
    
    // Tính vận tốc biến động điểm (Point Velocity)
    let velocity = 0;
    for (let i = 0; i < 5; i++) {
        velocity += (points[i] - points[i+1]);
    }

    // 3. Logic Dự đoán Tổng hợp
    let finalPred = -1;
    let logicMsg = "";
    let confBase = 80;

    // Quy luật 1: Hồi quy MD5 (Nếu entropy hash quá cao -> Đảo chiều xu hướng)
    if (Math.abs(hashEntropy % 10) > 7) {
        finalPred = results[0] === 1 ? 0 : 1;
        logicMsg = "HỒI QUY MD5: BIẾN ĐỘNG HASH CỰC ĐẠI";
        confBase = 93;
    } 
    // Quy luật 2: Động lực học điểm rơi (Velocity Analysis)
    else if (Math.abs(velocity) >= 12) {
        // Điểm rơi thay đổi quá nhanh -> Xu hướng sẽ đảo chiều để cân bằng
        finalPred = velocity > 0 ? 0 : 1;
        logicMsg = "ĐỘNG LỰC HỌC: ĐIỂM RƠI BIẾN THIÊN NHANH";
        confBase = 91;
    }
    // Quy luật 3: Chu kỳ lặp MD5 (Pattern Recognition)
    else {
        // Nếu không có biến động cực đoan, theo sát quy luật 2-2 hoặc 1-1 của MD5
        const pattern = results.slice(0, 4).join('');
        if (pattern === '1100' || pattern === '0011') {
            finalPred = results[0]; // Theo cầu 2-2
            logicMsg = "CHU KỲ MD5: XÁC NHẬN CẦU 2-2";
            confBase = 88;
        } else if (pattern === '1010' || pattern === '0101') {
            finalPred = results[0] === 1 ? 0 : 1; // Theo cầu 1-1
            logicMsg = "CHU KỲ MD5: XÁC NHẬN CẦU 1-1";
            confBase = 89;
        } else {
            // Mặc định: Thuật toán nén (Compression Algorithm)
            // Nếu 3 ván gần nhất tổng điểm > 33 -> Xỉu, < 18 -> Tài
            const recentSum = points.slice(0, 3).reduce((a, b) => a + b, 0);
            if (recentSum > 33) {
                finalPred = 0;
                logicMsg = "NÉN ĐIỂM SỐ: ÁP LỰC TÀI QUÁ CAO";
            } else if (recentSum < 18) {
                finalPred = 1;
                logicMsg = "NÉN ĐIỂM SỐ: ÁP LỰC XỈU QUÁ CAO";
            } else {
                finalPred = results[0] === 1 ? 1 : 0;
                logicMsg = "XU HƯỚNG MD5 HIỆN TẠI";
                confBase = 82;
            }
        }
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

        const sessions = data.list; 
        const latest = sessions[0];
        const phienVuaRa = latest.id;
        
        // Sửa lỗi null: API trả về mảng 'dices' thay vì dice1, dice2, dice3
        const dices = latest.dices || [0, 0, 0];
        const sum = latest.point || dices.reduce((a, b) => a + b, 0);
        let ketQua = latest.resultTruyenThong === 'TAI' ? "Tài" : "Xỉu";

        // Cập nhật kết quả phiên vừa ra
        await History.updateOne(
            { phien: phienVuaRa },
            { $set: { ketQua, tong: sum, dices: dices, hashId: latest._id } },
            { upsert: true }
        );

        // Dự đoán phiên mới
        const aiResult = getMD5MasterAlgorithm(sessions);
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
            Dices: dices,
            Tong_Diem: sum,
            Phien_Du_Doan: phienMoi,
            DU_DOAN: aiResult.prediction.toUpperCase(),
            Do_Tin_Cay: `${aiResult.confidence}%`,
            WinRate_10_Phien: `${winCount}/10`,
            Logic_Info: aiResult.logic,
            Version: "12.0 MD5 Master"
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(`🚀 AI v12.0 MD5 Master running on port ${port}`)); 
