const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// KẾT NỐI MONGODB
// ==========================================
const MONGODB_URI = "mongodb+srv://Bolakiettrumtx:Kiet280911@cluster0.izuwm8b.mongodb.net/taixiuDB?retryWrites=true&w=majority";
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB kết nối thành công!'))
  .catch(err => console.error('❌ Lỗi kết nối DB:', err));

// ==========================================
// SCHEMA
// ==========================================
const historySchema = new mongoose.Schema({
    phien:         { type: Number, required: true, unique: true },
    ketQua:        { type: String, default: null },
    tong:          { type: Number, default: null },
    dices:         [Number],
    duDoan:        { type: String, default: null },
    cauPhatHien:   { type: String, default: null },
    dungSai:       { type: String, default: null },
    hashId:        { type: String, default: null },
    timestamp:     { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

app.use(cors());
app.use(express.json());

// ==========================================
// BỘ THUẬT TOÁN LOGIC ĐA DẠNG
// ==========================================
const formulas = [
    { name: "Hash Parity", fn: (data, i) => {
        const target = data[i] || data[i-1]; // Nếu i chưa có (phiên mới), dùng i-1
        return parseInt(target._id.slice(-2), 16) % 2 === 0 ? "Tài" : "Xỉu";
    }},
    { name: "Point Parity", fn: (data, i) => data[i-1].point % 2 === 0 ? "Tài" : "Xỉu" },
    { name: "Bridge 1-1", fn: (data, i) => data[i-1].resultTruyenThong === "TAI" ? "Xỉu" : "Tài" },
    { name: "Sum Prev Points", fn: (data, i) => (data[i-1].point + data[i-2].point) % 2 === 0 ? "Tài" : "Xỉu" },
    { name: "MD5 Rule", fn: (data, i) => (data[i-1].dices[0] + data[i-1].dices[1] + data[i-1].dices[2]) % 2 === 0 ? "Tài" : "Xỉu" },
    { name: "Hash Bridge", fn: (data, i) => {
        const target = data[i] || data[i-1];
        return (parseInt(target._id.slice(-2), 16) + data[i-1].point) % 2 === 0 ? "Tài" : "Xỉu";
    }},
    { name: "Trend Inversion", fn: (data, i) => data[i-1].point > 10 ? "Xỉu" : "Tài" }
];

// ==========================================
// DYNAMIC LOGIC SELECTOR (TÌM THUẬT TOÁN ĐÚNG NHẤT)
// ==========================================
async function getDynamicPrediction(sessions) {
    // sessions là mảng list từ API gốc, đã đảo ngược (cũ -> mới)
    const len = sessions.length;
    if (len < 5) return { prediction: "Bỏ", reason: "Thiếu dữ liệu", confidence: 0 };

    let bestFormula = formulas[0];
    let maxScore = -1;

    // Chạy thử các công thức trên 5 phiên gần nhất
    for (const formula of formulas) {
        let score = 0;
        for (let j = len - 5; j < len; j++) {
            try {
                const pred = formula.fn(sessions, j);
                if (pred === sessions[j].resultTruyenThong) score++;
            } catch (e) {}
        }
        if (score > maxScore) {
            maxScore = score;
            bestFormula = formula;
        }
    }

    // Dự đoán cho phiên tiếp theo (phiên đang chờ)
    // Lưu ý: Trong API MD5, phiên đang chờ (đang đặt cược) thường chưa có Hash hoàn chỉnh hoặc chưa có trong list.
    // Tuy nhiên, các công thức của chúng ta chủ yếu dựa trên dữ liệu phiên trước (N-1).
    // Vì vậy, để dự đoán cho phiên mới (len), chúng ta truyền mảng sessions hiện tại vào.
    
    let prediction = "Bỏ";
    try {
        // Một số công thức cần truy cập sessions[i], một số cần sessions[i-1]
        // Ở đây i = len (phiên mới), nên i-1 là latest (phiên vừa ra)
        prediction = bestFormula.fn(sessions, len);
    } catch (e) {
        console.error("Lỗi khi chạy công thức dự đoán:", e.message);
        // Fallback: Nếu công thức cần Hash phiên hiện tại (chưa có), ta dùng kết quả phiên trước
        prediction = sessions[len-1].resultTruyenThong === "TAI" ? "Tài" : "Xỉu";
    }
    
    return {
        prediction,
        reason: `Sử dụng logic: ${bestFormula.name} (Độ chính xác gần đây: ${maxScore}/5)`,
        confidence: 60 + (maxScore * 5)
    };
}

// ==========================================
// API ENDPOINTS
// ==========================================

app.get('/api/taixiu', async (req, res) => {
    try {
        const apiUrl = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2';
        const response = await fetch(apiUrl);
        const data = await response.json();
        
        if (!data?.list) throw new Error("API Error");

        const sessions = data.list.reverse(); // Cũ -> Mới
        const latest = sessions[sessions.length - 1];
        const phienVuaRa = latest.id;
        const ketQua = latest.resultTruyenThong === "TAI" ? "Tài" : "Xỉu";

        // Cập nhật DB
        await History.updateOne(
            { phien: phienVuaRa },
            { $set: { ketQua, tong: latest.point, dices: latest.dices, hashId: latest._id } },
            { upsert: true }
        );

        // Lấy dự đoán động
        const prediction = await getDynamicPrediction(sessions);
        const phienMoi = phienVuaRa + 1;

        await History.updateOne(
            { phien: phienMoi },
            { $set: { duDoan: prediction.prediction, cauPhatHien: prediction.reason } },
            { upsert: true }
        );

        const stats = await getStats();

        res.json({
            Phien_vua_ra: phienVuaRa,
            Ket_qua: ketQua,
            Dices: latest.dices,
            Phien_du_doan: phienMoi,
            DU_DOAN: prediction.prediction,
            Ly_do: prediction.reason,
            Do_tin_cay: `${prediction.confidence}%`,
            Thong_ke: stats
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function getStats() {
    const rows = await History.find({ ketQua: { $ne: null }, duDoan: { $ne: null } })
        .sort({ phien: -1 }).limit(50).lean();
    const correct = rows.filter(r => r.ketQua === r.duDoan).length;
    return {
        winrate: rows.length > 0 ? ((correct / rows.length) * 100).toFixed(1) + "%" : "0%",
        sample: rows.length
    };
}

app.listen(port, () => console.log(`🚀 Server v8 - Dynamic Logic Selector chạy tại port ${port}`));
